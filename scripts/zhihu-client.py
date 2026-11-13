"""Narrow, JSON-only adapter for pyzhihu-cli; never persist or print cookies."""

import json
import logging
import re
import sys
import time
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

from markdown_it import MarkdownIt
from requests.cookies import create_cookie
from zhihu_cli.client import ZhihuClient

logging.disable(logging.CRITICAL)


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def normalize(html):
    parser = VisibleText()
    parser.feed(html)
    # Ignore editor whitespace; verify list and inline structure separately.
    return re.sub(r"[ \t\r\n\f\v]+", "", "".join(parser.parts))


class FormatStructure(HTMLParser):
    """Ignore editor wrappers while verifying list depth, links, and emphasis."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tokens = []

    def handle_starttag(self, tag, attrs):
        tag = {"b": "strong", "i": "em"}.get(tag, tag)
        if tag in ("ul", "ol", "li", "strong", "em", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.tokens.append("+" + tag)
        if tag == "a":
            self.tokens.append("link:" + dict(attrs).get("href", ""))

    def handle_endtag(self, tag):
        tag = {"b": "strong", "i": "em"}.get(tag, tag)
        if tag in ("ul", "ol", "li", "strong", "em", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.tokens.append("-" + tag)


def format_structure(html):
    parser = FormatStructure()
    parser.feed(html)
    return json.dumps(parser.tokens, ensure_ascii=False)


def validate_links(html):
    parser = FormatStructure()
    parser.feed(html)
    for token in parser.tokens:
        if token.startswith("link:"):
            parsed = urlparse(token[5:])
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ValueError("article_link_unsupported")


def load_client(snapshot_path):
    snapshot = json.loads(Path(snapshot_path).read_text(encoding="utf-8-sig"))
    if snapshot.get("schema") != "local.chrome-cookie-snapshot" or snapshot.get("schemaVersion") != 1:
        raise ValueError("cookie_snapshot_schema_mismatch")
    generated = datetime.fromisoformat(snapshot["generatedAt"].replace("Z", "+00:00")).timestamp()
    if not -30 <= time.time() - generated <= 900:
        raise ValueError("cookie_snapshot_stale")
    cookies = []
    for cookie in snapshot["cookies"]:
        domain = cookie.get("domain", "").lstrip(".").lower()
        if domain not in ("zhihu.com", "www.zhihu.com") or cookie.get("partitionKey"):
            continue
        if cookie.get("expirationDate") and cookie["expirationDate"] <= time.time():
            continue
        if cookie.get("path", "/") != "/":
            continue
        cookies.append(cookie)
    required = {"z_c0", "_xsrf", "d_c0"}
    if not required.issubset({cookie["name"] for cookie in cookies}):
        raise ValueError("zhihu_login_cookies_missing")
    # Preserve host-only/domain and path scope, unlike the CLI's convenience constructor.
    client = ZhihuClient({})
    for cookie in cookies:
        item = create_cookie(
            name=cookie["name"], value=cookie["value"], domain=cookie["domain"],
            path=cookie.get("path", "/"), secure=cookie.get("secure", False),
        )
        item.domain_specified = not cookie.get("hostOnly", False)
        client._session.cookies.set_cookie(item)
    xsrf = next(cookie["value"] for cookie in cookies if cookie["name"] == "_xsrf")
    client._session.headers["x-xsrftoken"] = xsrf
    original_request = client._session.request

    def scoped_request(method, url, **kwargs):
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ("www.zhihu.com", "zhuanlan.zhihu.com"):
            raise ValueError("zhihu_request_host_blocked")
        kwargs["allow_redirects"] = False
        return original_request(method, url, **kwargs)

    client._session.request = scoped_request
    return client


def prepare(nodes):
    """The marked root is the title; its physical descendants are the rich body."""
    md = MarkdownIt("commonmark", {"html": False})
    root_text = nodes[0]["text"]
    if "\n" in root_text or "\r" in root_text:
        raise ValueError("article_title_multiline")
    parser = VisibleText()
    parser.feed(md.renderInline(root_text))
    title = "".join(parser.parts)
    if not title.strip() or len(title) > 100:
        raise ValueError("article_title_length")
    index = 1

    def render_list(depth):
        nonlocal index
        parts = ["<ul>"]
        while index < len(nodes) and nodes[index]["depth"] == depth:
            node = nodes[index]
            index += 1
            parts.append("<li>" + md.render(node["text"]))
            if index < len(nodes) and nodes[index]["depth"] > depth:
                if nodes[index]["depth"] != depth + 1:
                    raise ValueError("article_outline_depth")
                parts.append(render_list(depth + 1))
            parts.append("</li>")
        parts.append("</ul>")
        return "".join(parts)

    html = render_list(1) if len(nodes) > 1 else ""
    if index != len(nodes):
        raise ValueError("article_outline_depth")
    text = normalize(html)
    if not 9 <= len(text) <= 100000:
        raise ValueError("article_body_length")
    validate_links(html)
    return {"title": title, "html": html, "text": text, "format": format_structure(html)}


def article_id_from_result(result):
    for key in ("id", "article_id"):
        value = str(result.get(key, ""))
        if re.fullmatch(r"\d+", value):
            return value
    for key in ("url", "redirect_url"):
        match = re.fullmatch(r"https://zhuanlan\.zhihu\.com/p/(\d+)/?", result.get(key, ""))
        if match:
            return match[1]
    raise ValueError("publish_result_id_missing")


def read_article(client, article_id):
    if not re.fullmatch(r"\d+", article_id):
        raise ValueError("invalid_article_id")
    article = client._get(f"https://zhuanlan.zhihu.com/api/articles/{article_id}")
    if article.get("state") != "published" or article.get("is_visible") is False or article.get("content_need_truncated"):
        raise ValueError("article_not_published")
    html = article.get("content", "")
    if not isinstance(html, str) or not html:
        raise ValueError("article_content_missing")
    return {"id": str(article.get("id", "")), "authorId": article.get("author", {}).get("id", ""),
            "title": article.get("title", ""), "text": normalize(html), "format": format_structure(html),
            "url": f"https://zhuanlan.zhihu.com/p/{article_id}"}


def main(request):
    action = request["action"]
    if action == "prepare":
        return prepare(request["nodes"])
    with load_client(request["snapshotPath"]) as client:
        me = client.get_self_info()
        account = {"id": me.get("id", ""), "name": me.get("name", ""),
                   "urlToken": me.get("url_token", "")}
        if not account["id"] or not account["urlToken"]:
            raise ValueError("zhihu_account_unverified")
        if action == "check":
            return account
        if account["id"] != request["expectedAccountId"]:
            raise ValueError("zhihu_account_changed")
        if action == "publish":
            # One attempt only. The caller persists an unknown-result fence before this call.
            result = client.create_article(request["title"], content=request["html"])
            return {"id": article_id_from_result(result)}
        if action == "verify":
            return read_article(client, request["articleId"])
        raise ValueError("unsupported_action")


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "data": main(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception as error:
        # Upstream exceptions can include response bodies; expose class or our fixed codes only.
        code = str(error) if type(error) is ValueError else type(error).__name__
        print(json.dumps({"ok": False, "error": code}))
        sys.exit(1)
