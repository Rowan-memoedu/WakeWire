"""Offline regression tests for the narrow client adapter (no real credentials)."""

import importlib.util
import json
import re
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch
from zhihu_cli.client import ZhihuClient

spec = importlib.util.spec_from_file_location("zhihu_adapter", Path(__file__).with_name("zhihu-client.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def snapshot(self, age=0):
        return json.dumps({
            "schema": "local.chrome-cookie-snapshot", "schemaVersion": 1,
            "generatedAt": datetime.fromtimestamp(time.time() - age, timezone.utc).isoformat(),
            "cookies": [
                {"name": name, "value": "synthetic", "domain": ".zhihu.com", "path": "/"}
                for name in ("z_c0", "_xsrf", "d_c0")
            ] + [{"name": "private", "value": "never-send", "domain": ".example.com", "path": "/"}],
        })

    def test_independent_outline_keeps_nested_lists_links_and_multiline(self):
        prepared = adapter.prepare([
            {"text": "A & B", "depth": 0},
            {"text": "**First** [source](https://example.com)", "depth": 1},
            {"text": "Nested detail\nsecond line", "depth": 2},
            {"text": "Last", "depth": 1},
        ])
        self.assertEqual(prepared["title"], "A & B")
        self.assertEqual(prepared["html"].count("<ul>"), 2)
        self.assertIn("<strong>First</strong>", prepared["html"])
        self.assertIn('href="https://example.com"', prepared["html"])
        self.assertEqual(prepared["text"], "FirstsourceNesteddetailsecondlineLast")
        self.assertIn("+strong", prepared["format"])

    def test_source_html_never_becomes_executable(self):
        html = adapter.prepare([{"text": "A title", "depth": 0}, {"text": '<script>alert("test")</script>', "depth": 1}])["html"]
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_only_matching_cookie_domains_are_loaded_and_redirects_are_disabled(self):
        with patch.object(Path, "read_text", return_value=self.snapshot()):
            client = adapter.load_client("synthetic.json")
        self.assertNotIn("private", [cookie.name for cookie in client._session.cookies])
        with self.assertRaisesRegex(ValueError, "host_blocked"):
            client._session.request("GET", "https://example.com/")
        client.close()

    def test_stale_snapshot_cannot_reuse_logged_out_or_disconnected_auth(self):
        with patch.object(Path, "read_text", return_value=self.snapshot(age=1000)):
            with self.assertRaisesRegex(ValueError, "stale"):
                adapter.load_client("synthetic.json")

    def test_empty_snapshot_cannot_reuse_old_cookies(self):
        snapshot = json.loads(self.snapshot())
        snapshot["cookies"] = []
        with patch.object(Path, "read_text", return_value=json.dumps(snapshot)):
            with self.assertRaisesRegex(ValueError, "missing"):
                adapter.load_client("synthetic.json")

    def test_account_switch_prevents_post(self):
        client = MagicMock()
        client.__enter__.return_value = client
        client.get_self_info.return_value = {"id": "new", "url_token": "new"}
        with patch.object(adapter, "load_client", return_value=client):
            with self.assertRaisesRegex(ValueError, "account_changed"):
                adapter.main({"action": "publish", "snapshotPath": "synthetic", "expectedAccountId": "old", "title": "A title", "html": "body"})
        client.create_article.assert_not_called()

    def test_article_id_requires_a_concrete_id(self):
        self.assertEqual(adapter.article_id_from_result({"id": "123"}), "123")
        self.assertEqual(adapter.article_id_from_result({"url": "https://zhuanlan.zhihu.com/p/456"}), "456")
        with self.assertRaisesRegex(ValueError, "missing"):
            adapter.article_id_from_result({"code": 0})

    def test_public_readback_contains_author_and_visible_text(self):
        client = MagicMock()
        client._get.return_value = {"id": "123", "title": "A title", "state": "published", "author": {"id": "me"}, "content": "<p>One &amp; two</p>"}
        result = adapter.read_article(client, "123")
        self.assertEqual(result["text"], "One&two")
        self.assertEqual(result["authorId"], "me")
        self.assertEqual(result["columnIds"], [])
        self.assertEqual(json.loads(result["format"])["blocks"], [{"kind": "paragraph", "depth": 0, "text": "One&two"}])
        client._get.return_value["state"] = "draft"
        with self.assertRaisesRegex(ValueError, "not_published"):
            adapter.read_article(client, "123")

    def test_title_and_body_limits_never_truncate_or_generate_content(self):
        for nodes in (
            [{"text": "Title\nother line", "depth": 0}, {"text": "Long enough body", "depth": 1}],
            [{"text": "Title", "depth": 0}],
            [{"text": "Title", "depth": 0}, {"text": "Short", "depth": 1}],
            [{"text": "T" * 101, "depth": 0}, {"text": "Long enough body", "depth": 1}],
        ):
            with self.assertRaises(ValueError):
                adapter.prepare(nodes)

    def test_format_comparison_preserves_hierarchy_and_links(self):
        nested = "<ul><li>A<ul><li>B</li></ul></li></ul>"
        flat = "<ul><li>A</li><li>B</li></ul>"
        self.assertNotEqual(adapter.format_structure(nested), adapter.format_structure(flat))
        self.assertEqual(adapter.format_structure("<b>Strong</b>"), adapter.format_structure("<strong>Strong</strong>"))
        self.assertNotEqual(adapter.format_structure('<a href="https://one.example">link</a>'), adapter.format_structure('<a href="https://two.example">link</a>'))
        with self.assertRaisesRegex(ValueError, "link_unsupported"):
            adapter.prepare([{"text": "A title", "depth": 0}, {"text": "A relative [source](../local.md) with text", "depth": 1}])

    def test_pinned_upstream_article_client_full_sequence_without_network(self):
        client = ZhihuClient({})
        calls = []

        def respond(method, url, **kwargs):
            calls.append((method.upper(), url))
            if url.endswith("/me"):
                data = {"id": "me", "url_token": "synthetic"}
            elif "/columns/" in url:
                data = {"id": "synthetic-column", "url_token": "synthetic-column", "can_manage": True}
            elif url.endswith("/articles/drafts"):
                data = {"id": "789"}
            elif url.endswith("/draft"):
                self.assertEqual(kwargs["json"], {"title": "A title", "content": "<p>Independent body</p>"})
                data = {}
            elif url.endswith("/publish"):
                self.assertEqual(kwargs["json"]["column"], "synthetic-column")
                data = {"id": "789", "state": "published"}
            else:
                self.fail("unexpected upstream request")
            result = MagicMock()
            result.status_code = 200
            result.json.return_value = data
            return result

        with patch.object(adapter, "load_client", return_value=client), patch.object(client._session, "request", side_effect=respond):
            result = adapter.main({"action": "publish", "snapshotPath": "synthetic", "expectedAccountId": "me", "title": "A title", "html": "<p>Independent body</p>", "columnId": "synthetic-column"})
        self.assertEqual(result, {"id": "789"})
        self.assertEqual([method for method, _ in calls], ["GET", "GET", "POST", "PATCH", "PUT"])
        self.assertTrue(all("/pin" not in url for _, url in calls))

    def test_only_accepted_columns_count_as_membership(self):
        client = MagicMock()
        client._get.return_value = {"id": "12", "title": "Title", "state": "published", "content": "<p>Published body</p>",
            "contributions": [{"state": "accepted", "column": {"url_token": "accepted-column"}}, {"state": "pending", "column": {"url_token": "pending-column"}}]}
        self.assertEqual(adapter.read_article(client, "12")["columnIds"], ["accepted-column"])

    def test_unmanageable_column_blocks_all_article_mutations(self):
        client = MagicMock()
        client._get.return_value = {"url_token": "column", "can_manage": False}
        with self.assertRaisesRegex(ValueError, "not_manageable"):
            adapter.publish_in_column(client, "Title", "<p>Body text</p>", "column")
        client.create_article.assert_not_called()


class LayoutTests(unittest.TestCase):
    def prepare(self, rows):
        return adapter.prepare([{"depth": 0, "text": "Independent title"}] + [{"depth": depth, "text": text} for depth, text in rows])

    def blocks(self, result):
        return json.loads(result["format"])["blocks"]

    def test_empty_editor_edges_are_omitted_and_inner_blank_is_a_paragraph(self):
        result = self.prepare([(1, ""), (1, "First section"), (1, ""), (1, "Second section"), (1, ""), (1, " ")])
        self.assertEqual([block["kind"] for block in self.blocks(result)], ["item", "gap", "item"])
        self.assertEqual(result["html"].count('class="ztext-empty-paragraph"'), 1)
        self.assertNotIn("<li></li>", result["html"])

    def test_consecutive_authored_blank_nodes_remain_separate(self):
        result = self.prepare([(1, "First section"), (1, ""), (1, ""), (1, "Next section")])
        self.assertEqual([block["kind"] for block in self.blocks(result)], ["item", "gap", "gap", "item"])

    def test_nested_separator_keeps_the_children_at_the_original_depth(self):
        result = self.prepare([(1, "Parent item"), (2, "First detail"), (2, ""), (2, "Second detail"), (1, "Sibling item")])
        self.assertEqual([(block["kind"], block["depth"]) for block in self.blocks(result)], [("item", 1), ("item", 2), ("gap", 1), ("item", 2), ("item", 1)])

    def test_node_internal_single_and_double_newlines_are_visible_breaks(self):
        result = self.prepare([(1, "First line\nSecond line\n\nThird line")])
        self.assertEqual(self.blocks(result)[0]["text"], "Firstline\nSecondline\n\nThirdline")
        self.assertEqual(len(re.findall(r"<br\s*/?>", result["html"])), 3)

    def test_readback_rejects_missing_newline_even_when_all_words_match(self):
        first = "<ul><li>First<br>Second text</li></ul>"
        second = "<ul><li>First Second text</li></ul>"
        self.assertEqual(adapter.normalize(first), adapter.normalize(second))
        self.assertNotEqual(adapter.format_structure(first), adapter.format_structure(second))

    def test_readback_accepts_zhihu_reparenting_lists_and_b_tag_normalization(self):
        valid = "<ul><li><p>Parent <strong>bold</strong></p><ul><li>Child detail</li></ul></li></ul>"
        native = '<ul><li data-pid="opaque">Parent <b>bold</b></li><ul><li>Child detail</li></ul></ul>'
        self.assertEqual(adapter.format_structure(valid), adapter.format_structure(native))

    def test_style_offsets_are_visible_text_offsets_not_html_parser_columns(self):
        wrapped = "<ul>\n<li>Earlier text</li>\n<li><strong>Bold</strong></li></ul>"
        compact = "<ul><li>Earlier text</li><li><b>Bold</b></li></ul>"
        self.assertEqual(adapter.format_structure(wrapped), adapter.format_structure(compact))

    def test_blank_structural_container_keeps_descendants_without_empty_bullet(self):
        result = self.prepare([(1, ""), (2, "A complete nested detail")])
        self.assertEqual(self.blocks(result), [{"kind": "item", "depth": 2, "list": "ul", "text": "Acompletenesteddetail"}])
        self.assertNotIn("<li></li>", result["html"])

    def test_wrong_list_depth_and_wrong_blank_position_are_not_equivalent(self):
        one = '<ul><li>First</li></ul><p class="ztext-empty-paragraph"><br></p><ul><li>Second</li></ul>'
        two = '<ul><li>First</li><ul><li>Second</li></ul></ul><p><br></p>'
        self.assertEqual(adapter.normalize(one), adapter.normalize(two))
        self.assertNotEqual(adapter.format_structure(one), adapter.format_structure(two))


if __name__ == "__main__":
    unittest.main()
