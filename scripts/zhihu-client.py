"""Narrow, JSON-only adapter for pyzhihu-cli; never persist or print cookies."""

import json
import logging
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from requests.cookies import create_cookie
from zhihu_cli.client import ZhihuClient
from zhihu_article_format import (
    ArticleLayout,
    format_structure,
    normalize,
    prepare as prepare_layout,
)

logging.disable(logging.CRITICAL)


def validate_links(html):
    parser = ArticleLayout()
    parser.feed(html)
    for href in parser.links:
        parsed = urlparse(href)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("article_link_unsupported")


def prepare(nodes):
    result = prepare_layout(nodes)
    validate_links(result["html"])
    return result


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
    columns = {item.get("column", {}).get("url_token") or item.get("column", {}).get("id")
               for item in article.get("contributions", []) if item.get("state") == "accepted"}
    # A primary column is accepted only when the server also exposes that accepted contribution.
    columns.discard(None)
    return {"id": str(article.get("id", "")), "authorId": article.get("author", {}).get("id", ""),
            "title": article.get("title", "") or "", "text": normalize(html), "format": format_structure(html),
            "columnIds": sorted(columns),
            "url": f"https://zhuanlan.zhihu.com/p/{article_id}"}


def check_column(client, column_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", column_id):
        raise ValueError("invalid_column_id")
    column = client._get(f"https://zhuanlan.zhihu.com/api/columns/{column_id}")
    if (column.get("url_token") or column.get("id")) != column_id or column.get("can_manage") is not True:
        raise ValueError("column_not_manageable")
    return {"columnId": column_id, "columnTitle": column.get("title", "")}


def series_stats(client, column_id):
    check_column(client, column_id)
    column = client._get(f"https://zhuanlan.zhihu.com/api/columns/{column_id}")
    count = column.get("articles_count")
    if not isinstance(count, int) or not 0 <= count <= 10000:
        raise ValueError("series_count_invalid")
    articles = []
    while len(articles) < count:
        page = client._get(f"https://zhuanlan.zhihu.com/api/columns/{column_id}/articles", {"limit": 20, "offset": len(articles)})
        page = page if isinstance(page, list) else page.get("data", [])
        if not page:
            raise ValueError("series_pagination_incomplete")
        articles.extend(page)
    ids = [str(article.get("id", "")) for article in articles]
    if len(set(ids)) != len(ids) or len(ids) != count:
        raise ValueError("series_listing_changed")
    ordinals = []
    for article in articles:
        match = re.search(r"（第(\d+)\s*篇\s*\|\s*day\s*\d+）$", article.get("title", ""))
        if match:
            ordinals.append(int(match[1]))
    return {"publishedCount": count, "maxOrdinal": max(ordinals, default=0)}


def read_draft(client, article_id):
    if not re.fullmatch(r"\d+", article_id):
        raise ValueError("invalid_draft_id")
    url = f"https://zhuanlan.zhihu.com/api/articles/{article_id}"
    response = client._session.get(url, timeout=15)
    if response.status_code == 404:
        article = client._get(url + "/draft")
    elif response.status_code == 200:
        article = response.json()
    else:
        raise ValueError("draft_read_failed")
    html = article.get("content", "") or ""
    return {"id": str(article.get("id", "")), "authorId": article.get("author", {}).get("id", ""),
            "title": article.get("title", "") or "", "text": normalize(html), "format": format_structure(html),
            "state": article.get("state", ""), "editorUrl": f"https://zhuanlan.zhihu.com/p/{article_id}/edit"}


def create_draft(client):
    response = client._session.post("https://zhuanlan.zhihu.com/api/articles/drafts", json={}, timeout=15)
    if response.status_code != 200:
        raise ValueError("draft_create_failed")
    return {"id": article_id_from_result(response.json())}


def write_draft(client, article_id, title, html, account_id, expected):
    current = read_draft(client, article_id)
    if current["authorId"] != account_id or current["state"] != "draft":
        raise ValueError("draft_identity_or_state_changed")
    if any(current[key] != expected[key] for key in ("title", "text", "format")):
        raise ValueError("cloud_draft_edited")
    response = client._session.patch(f"https://zhuanlan.zhihu.com/api/articles/{article_id}/draft", json={"title": title, "content": html}, timeout=15)
    if response.status_code != 200:
        raise ValueError("draft_save_failed")
    saved = read_draft(client, article_id)
    if saved["title"] != title or saved["text"] != normalize(html) or saved["format"] != format_structure(html) or saved["state"] != "draft":
        raise ValueError("draft_readback_mismatch")
    return saved


def publish_saved_draft(client, article_id, title, html, column_id, account_id, expected):
    check_column(client, column_id)
    write_draft(client, article_id, title, html, account_id, expected)
    response = client._session.put(f"https://zhuanlan.zhihu.com/api/articles/{article_id}/publish", json={"column": column_id, "commentPermission": "anyone"}, timeout=15)
    if response.status_code != 200:
        raise ValueError("saved_draft_publish_failed")
    return {"id": article_id_from_result(response.json())}


def publish_in_column(client, title, html, column_id):
    check_column(client, column_id)
    original_request = client._session.request

    def request_with_column(method, url, **kwargs):
        if method.upper() == "PUT" and re.fullmatch(r"https://zhuanlan\.zhihu\.com/api/articles/\d+/publish", url):
            payload = dict(kwargs.get("json", {}))
            if payload.get("column") not in (None, column_id):
                raise ValueError("unexpected_publish_column")
            payload["column"] = column_id
            kwargs["json"] = payload
        return original_request(method, url, **kwargs)

    client._session.request = request_with_column
    try:
        # Reuse the pinned client's draft/update/publish flow, changing only the column field.
        return client.create_article(title, content=html)
    finally:
        client._session.request = original_request


def main(request):
    action = request["action"]
    if action == "prepare":
        result = prepare(request["nodes"])
        validate_links(result["html"])
        return result
    with load_client(request["snapshotPath"]) as client:
        me = client.get_self_info()
        account = {"id": me.get("id", ""), "name": me.get("name", ""),
                   "urlToken": me.get("url_token", "")}
        if not account["id"] or not account["urlToken"]:
            raise ValueError("zhihu_account_unverified")
        if action == "check":
            return {**account, **check_column(client, request["columnId"])}
        if account["id"] != request["expectedAccountId"]:
            raise ValueError("zhihu_account_changed")
        if action == "series":
            return series_stats(client, request["columnId"])
        if action == "create-draft":
            check_column(client, request["columnId"])
            return create_draft(client)
        if action == "read-draft":
            return read_draft(client, request["articleId"])
        if action == "write-draft":
            return write_draft(client, request["articleId"], request["title"], request["html"], account["id"], request["expected"])
        if action == "publish":
            if request.get("draftId"):
                return publish_saved_draft(client, request["draftId"], request["title"], request["html"], request["columnId"], account["id"], request["expected"])
            # One attempt only. The caller persists an unknown-result fence before this call.
            result = publish_in_column(client, request["title"], request["html"], request["columnId"])
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
