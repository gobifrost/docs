"""Disposable IT Glue-shaped HTTP fixture for isolated Bifrost integration QA.

Run with ``python3 tests/mock_itglue_server.py``. POST /__mode?deleted=1 to
remove the fixture document, so a second sync can exercise guarded deletion.
Never point a production Integration at this server.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


HOST = os.environ.get("MOCK_ITGLUE_HOST", "127.0.0.1")
PORT = int(os.environ.get("MOCK_ITGLUE_PORT", "38777"))
SOURCE = f"http://{HOST}:{PORT}"
STATE = {"deleted": False, "changed": False, "taxonomy_deleted": False, "taxonomy_changed": False}


def record(kind: str, ident: str, **attributes: object) -> dict:
    return {"type": kind, "id": ident, "attributes": attributes}


FOLDER = record("document-folders", "20", name="Runbooks", restricted=False)
CONFIGURATION_TYPE = record(
    "configuration-types", "40", name="Firewall", updated_at="2026-09-23T00:00:00Z"
)
CONFIGURATION_STATUS = record(
    "configuration-statuses", "50", name="Active", updated_at="2026-09-23T00:00:00Z"
)
DOCUMENT = record(
    "documents", "10", name="VPN runbook", document_folder_id="20",
    updated_at="2026-09-23T00:00:00Z", restricted=True,
    resource_url="https://app.itglue.com/1/docs/10",
)
PASSWORD = record(
    "passwords", "30", name="VPN admin", username="operator",
    updated_at="2026-09-23T00:00:00Z", restricted=False,
    resource_url="https://app.itglue.com/1/passwords/30",
)
ATTACHMENT = record(
    "attachments", "900", name="vpn.txt", attachment_file_name="vpn.txt",
    attachment_content_type="text/plain", attachment_file_size=11,
    updated_at="2026-09-23T00:00:00Z", download_url=f"{SOURCE}/blob/900",
)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_: object) -> None:
        return

    def respond(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/vnd.api+json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/__mode":
            self.respond(404, {"errors": [{"title": "Not found"}]})
            return
        query = parse_qs(parsed.query)
        STATE["deleted"] = query.get("deleted") == ["1"]
        STATE["changed"] = query.get("changed") == ["1"]
        STATE["taxonomy_deleted"] = query.get("taxonomy_deleted") == ["1"]
        STATE["taxonomy_changed"] = query.get("taxonomy_changed") == ["1"]
        self.respond(200, STATE)

    def do_GET(self) -> None:
        if self.headers.get("x-api-key") != "synthetic-fixture-key":
            self.respond(401, {"errors": [{"title": "Unauthorized"}]})
            return
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        current_document = dict(DOCUMENT)
        current_document["attributes"] = dict(DOCUMENT["attributes"])
        current_type = dict(CONFIGURATION_TYPE)
        current_type["attributes"] = dict(CONFIGURATION_TYPE["attributes"])
        if STATE["taxonomy_changed"]:
            current_type["attributes"]["name"] = "Network firewall"
            current_type["attributes"]["updated_at"] = "2026-09-24T00:00:00Z"
        if STATE["changed"]:
            current_document["attributes"]["updated_at"] = "2026-09-24T00:00:00Z"
            current_document["attributes"]["name"] = "VPN runbook updated upstream"
        if path == "/blob/900":
            body = b"VPN guide.\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        lists = {
            "/configuration_types": [] if STATE["taxonomy_deleted"] else [current_type],
            "/configuration_statuses": [CONFIGURATION_STATUS],
            "/flexible_asset_types": [],
            "/organizations/123/relationships/document_folders": [FOLDER],
            "/organizations/123/relationships/password_folders": [],
            "/organizations/123/relationships/locations": [],
            "/organizations/123/relationships/configurations": [],
            # The fixture document deliberately lives in folder 20. IT Glue
            # requires this literal query value to include nested documents.
            "/organizations/123/relationships/documents": (
                [] if STATE["deleted"] or query.get("filter[document_folder_id]") != ["null"]
                else [current_document]
            ),
            "/organizations/123/relationships/flexible_assets": [],
            "/organizations/123/relationships/passwords": [PASSWORD],
            "/documents/10/relationships/sections": [] if STATE["deleted"] else [
                record("document-sections", "100", content="Connect through the managed VPN client.",
                       rendered_content="Connect through the managed VPN client.")
            ],
        }
        if path in lists:
            self.respond(200, {"data": lists[path], "meta": {"total-pages": 1, "total-count": len(lists[path])}})
            return
        if path == "/documents/10" and not STATE["deleted"]:
            self.respond(200, {"data": current_document, "included": [ATTACHMENT]})
            return
        if path == "/passwords/30":
            self.respond(200, {"data": PASSWORD, "included": []})
            return
        if path == "/document_folders/20":
            self.respond(200, {"data": FOLDER, "included": []})
            return
        if path == "/configuration_types/40" and not STATE["taxonomy_deleted"]:
            self.respond(200, {"data": current_type, "included": []})
            return
        if path == "/configuration_statuses/50":
            self.respond(200, {"data": CONFIGURATION_STATUS, "included": []})
            return
        self.respond(404, {"errors": [{"title": "Not found"}]})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
