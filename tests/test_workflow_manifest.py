from __future__ import annotations

import ast
from pathlib import Path

import yaml


ROOT = Path(__file__).parents[1]


def _decorated_workflows() -> dict[tuple[str, str], tuple[str, str]]:
    result: dict[tuple[str, str], tuple[str, str]] = {}
    for path in (ROOT / "functions").glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not (
                    isinstance(decorator, ast.Call)
                    and isinstance(decorator.func, ast.Name)
                    and decorator.func.id in {"tool", "workflow"}
                ):
                    continue
                values = {
                    keyword.arg: ast.literal_eval(keyword.value)
                    for keyword in decorator.keywords
                    if keyword.arg in {"name", "description"}
                }
                if "name" in values and "description" in values:
                    result[(str(path.relative_to(ROOT)), node.name)] = (
                        decorator.func.id,
                        str(values["description"]),
                    )
    return result


def test_agent_tool_manifest_entries_have_registry_type_and_description() -> None:
    declared = yaml.safe_load((ROOT / ".bifrost/workflows.yaml").read_text())["workflows"]
    by_target = {
        (entry["path"], entry["function_name"]): entry
        for entry in declared.values()
    }

    for target, (decorator, description) in _decorated_workflows().items():
        entry = by_target[target]
        assert entry["type"] == ("tool" if decorator == "tool" else "workflow")
        assert entry["description"] == description


def test_audit_and_document_state_are_written_only_by_guarded_workflows() -> None:
    """Browser table calls must not forge audit events or publish documents directly."""
    tables = yaml.safe_load((ROOT / ".bifrost/tables.yaml").read_text())["tables"]
    audit_table = next(table for table in tables.values() if table["name"] == "docs-audit-events")
    documents_table = next(table for table in tables.values() if table["name"] == "docs-documents")
    attachments_table = next(table for table in tables.values() if table["name"] == "docs-attachments")

    assert [policy["name"] for policy in audit_table["policies"]] == [
        "platform_admin_bypass",
        "docs_audit_read",
    ]
    assert [policy["name"] for policy in documents_table["policies"]] == ["platform_admin_bypass", "docs_tenant_read_unrestricted"]
    assert [policy["name"] for policy in attachments_table["policies"]] == ["platform_admin_bypass", "docs_tenant_read_unrestricted"]
