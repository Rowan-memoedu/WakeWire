"""Offline regression tests for the narrow client adapter (no real credentials)."""

import importlib.util
import json
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
        self.assertEqual(adapter.read_article(client, "123"), {"id": "123", "title": "A title", "authorId": "me", "text": "One&two", "format": "[]", "url": "https://zhuanlan.zhihu.com/p/123"})
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
            elif url.endswith("/articles/drafts"):
                data = {"id": "789"}
            elif url.endswith("/draft"):
                self.assertEqual(kwargs["json"], {"title": "A title", "content": "<p>Independent body</p>"})
                data = {}
            elif url.endswith("/publish"):
                data = {"id": "789", "state": "published"}
            else:
                self.fail("unexpected upstream request")
            result = MagicMock()
            result.status_code = 200
            result.json.return_value = data
            return result

        with patch.object(adapter, "load_client", return_value=client), patch.object(client._session, "request", side_effect=respond):
            result = adapter.main({"action": "publish", "snapshotPath": "synthetic", "expectedAccountId": "me", "title": "A title", "html": "<p>Independent body</p>"})
        self.assertEqual(result, {"id": "789"})
        self.assertEqual([method for method, _ in calls], ["GET", "POST", "PATCH", "PUT"])
        self.assertTrue(all("/pin" not in url for _, url in calls))


if __name__ == "__main__":
    unittest.main()
