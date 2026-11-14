"""Lossless outline layout for Zhihu articles, independent of live account data."""

import json
import re
from html.parser import HTMLParser

from markdown_it import MarkdownIt


def compact(text):
    return re.sub(r"[ \t\r\n\f\v]+", "", text)


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def normalize(html):
    parser = VisibleText()
    parser.feed(html)
    return compact("".join(parser.parts))


class ArticleLayout(HTMLParser):
    """Compare visible layout, accepting both valid nested lists and Zhihu's list DOM."""
    INLINE = {"strong", "em", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.events = []
        self.lists = []
        self.items = []
        self.paragraphs = []
        self.styles = []
        self.links = []
        self.visible_offset = 0
        self.pre_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = {"b": "strong", "i": "em"}.get(tag, tag)
        if tag in ("ul", "ol"):
            self.lists.append(tag)
        elif tag == "li":
            item = {"kind": "item", "depth": len(self.lists), "list": self.lists[-1] if self.lists else "none", "text": ""}
            self.events.append(item)
            self.items.append(item)
        elif tag == "p":
            self.paragraphs.append({"parts": [], "target": self.items[-1] if self.items else None, "depth": len(self.lists)})
        elif tag == "br":
            if self.paragraphs:
                self.paragraphs[-1]["parts"].append("\n")
            elif self.items:
                self.items[-1]["text"] += "\n"
            else:
                self.events.append({"kind": "gap", "depth": len(self.lists)})
        if tag in self.INLINE:
            self.styles.append(["+" + tag, self.visible_offset])
        if tag == "pre":
            self.pre_depth += 1
        if tag == "a":
            href = dict(attrs).get("href", "")
            self.links.append(href)
            self.styles.append(["+a", href, self.visible_offset])

    def handle_endtag(self, tag):
        tag = {"b": "strong", "i": "em"}.get(tag, tag)
        if tag in ("ul", "ol") and self.lists:
            self.lists.pop()
        elif tag == "li" and self.items:
            self.items.pop()
        elif tag == "p" and self.paragraphs:
            paragraph = self.paragraphs.pop()
            value = "".join(paragraph["parts"])
            if not value.strip("\n"):
                self.events.append({"kind": "gap", "depth": paragraph["depth"]})
            elif paragraph["target"] is not None:
                target = paragraph["target"]
                if target["text"]:
                    target["text"] += "\n\n"
                target["text"] += value
            else:
                self.events.append({"kind": "paragraph", "depth": paragraph["depth"], "text": value})
        if tag in self.INLINE:
            self.styles.append(["-" + tag, self.visible_offset])
        if tag == "pre":
            self.pre_depth -= 1
        if tag == "a":
            self.styles.append(["-a", self.visible_offset])

    def handle_data(self, data):
        # Formatting whitespace in HTML is not a visible newline; <br> is.
        value = data if self.pre_depth else compact(data)
        self.visible_offset += len(compact(data))
        if not value:
            return
        if self.paragraphs:
            self.paragraphs[-1]["parts"].append(value)
        elif self.items:
            self.items[-1]["text"] += value
        elif self.events and self.events[-1]["kind"] == "paragraph":
            self.events[-1]["text"] += value
        else:
            self.events.append({"kind": "paragraph", "depth": len(self.lists), "text": value})


def format_structure(html):
    parser = ArticleLayout()
    parser.feed(html)
    return json.dumps({"version": 2, "blocks": parser.events, "styles": parser.styles}, ensure_ascii=False)


def prepare(nodes):
    """Blank Rems are paragraph separators; real Rems are list items; LF stays LF."""
    md = MarkdownIt("commonmark", {"html": False, "breaks": True})
    root_text = nodes[0]["text"]
    if "\n" in root_text or "\r" in root_text:
        raise ValueError("article_title_multiline")
    parser = VisibleText()
    parser.feed(md.renderInline(root_text))
    title = "".join(parser.parts)
    if not title.strip() or len(title) > 100:
        raise ValueError("article_title_length")
    root = {"text": root_text, "children": []}
    stack = [root]
    for node in nodes[1:]:
        depth = node["depth"]
        if not 1 <= depth <= len(stack):
            raise ValueError("article_outline_depth")
        del stack[depth:]
        current = {"text": node["text"], "children": []}
        stack[-1]["children"].append(current)
        stack.append(current)

    def inline_or_blocks(text):
        tokens = md.parse(text)
        if all(token.type in ("paragraph_open", "inline", "paragraph_close") for token in tokens):
            return md.renderInline(text)
        return md.render(text)

    def render_level(children):
        def visible(node):
            return bool(node["text"].strip()) or any(visible(child) for child in node["children"])

        # Empty editor placeholders at a sibling group's edges are not section separators.
        children = list(children)
        while children and not visible(children[0]):
            children.pop(0)
        while children and not visible(children[-1]):
            children.pop()
        result, items = [], []

        def flush():
            if items:
                result.append("<ul>" + "".join(items) + "</ul>")
                items.clear()

        for node in children:
            if not node["text"].strip():
                flush()
                if node["children"]:
                    # Preserve a blank structural container's depth, with no phantom bullet.
                    result.append("<ul>" + render_level(node["children"]) + "</ul>")
                else:
                    result.append('<p class="ztext-empty-paragraph"><br/></p>')
                continue
            # Zhihu's Draft.js importer synthesizes an empty block for every
            # closing parent <li> around a child list. Its native serializer
            # places the child <ul> after the closed <li>, at the same level.
            # Emit that representation so a hierarchy return is not a blank Rem.
            items.append("<li>" + inline_or_blocks(node["text"]) + "</li>" + render_level(node["children"]))
        flush()
        return "".join(result)

    html = render_level(root["children"])
    text = normalize(html)
    if not 9 <= len(text) <= 100000:
        raise ValueError("article_body_length")
    return {"title": title, "html": html, "text": text, "format": format_structure(html)}
