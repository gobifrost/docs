import "./components.css";
import "./BfDataTable.css";
import { useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsUpDown, RotateCcw } from "lucide-react";
import { BfButton } from "./BfButton";

export type BfSortDirection = "ascending" | "descending";

export interface BfDataColumn<Row> {
  id: string;
  header: ReactNode;
  accessor?: keyof Row | ((row: Row) => ReactNode);
  cell?: (row: Row) => ReactNode;
  sortValue?: (row: Row) => string | number | Date | null | undefined;
  sortable?: boolean;
  align?: "start" | "center" | "end";
  width?: string;
  className?: string;
}

export interface BfDataTableSort {
  columnId: string;
  direction: BfSortDirection;
}

export interface BfDataTablePagination {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export interface BfDataTableState {
  title: string;
  description?: string;
  action?: ReactNode;
}

export interface BfDataTableError extends BfDataTableState {
  onRetry?: () => void;
}

export interface BfDataTableProps<Row> {
  rows: Row[];
  columns: BfDataColumn<Row>[];
  getRowId: (row: Row) => string;
  caption?: string;
  ariaLabel?: string;
  toolbar?: ReactNode;
  footer?: ReactNode;
  loading?: boolean;
  loadingRowCount?: number;
  error?: BfDataTableError;
  emptyState?: BfDataTableState;
  sort?: BfDataTableSort;
  defaultSort?: BfDataTableSort;
  onSortChange?: (sort: BfDataTableSort) => void;
  selection?: "none" | "single" | "multiple";
  selectedRowIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  isRowSelectable?: (row: Row) => boolean;
  getRowHref?: (row: Row) => string | undefined;
  onRowActivate?: (row: Row) => void;
  pagination?: BfDataTablePagination;
  stickyHeader?: boolean;
  maxHeight?: string;
  minWidth?: string;
  className?: string;
}

const DATA_COLUMN_MIN_WIDTH = 144;
const SELECTION_COLUMN_WIDTH = 42;

function readCell<Row>(column: BfDataColumn<Row>, row: Row): ReactNode {
  if (column.cell) return column.cell(row);
  if (typeof column.accessor === "function") return column.accessor(row);
  if (column.accessor) return row[column.accessor] as ReactNode;
  return null;
}

function comparable(value: string | number | Date | null | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return value.toLocaleLowerCase();
  return value ?? "";
}

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a, button, input, label, select, textarea, [role=button], [role=menuitem]"));
}

export function BfDataTable<Row>({
  rows,
  columns,
  getRowId,
  caption,
  ariaLabel,
  toolbar,
  footer,
  loading = false,
  loadingRowCount = 5,
  error,
  emptyState = { title: "No results", description: "There is nothing to show yet." },
  sort: controlledSort,
  defaultSort,
  onSortChange,
  selection = "none",
  selectedRowIds = [],
  onSelectionChange,
  isRowSelectable,
  getRowHref,
  onRowActivate,
  pagination,
  stickyHeader = true,
  maxHeight = "32rem",
  minWidth = "100%",
  className = "",
}: BfDataTableProps<Row>) {
  const [internalSort, setInternalSort] = useState<BfDataTableSort | undefined>(defaultSort);
  const sort = controlledSort ?? internalSort;
  const selectedSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);
  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((item) => item.id === sort.columnId);
    if (!column) return rows;
    return [...rows].sort((left, right) => {
      const leftValue = comparable(column.sortValue?.(left) ?? String(readCell(column, left) ?? ""));
      const rightValue = comparable(column.sortValue?.(right) ?? String(readCell(column, right) ?? ""));
      const result = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      return sort.direction === "ascending" ? result : -result;
    });
  }, [columns, rows, sort]);

  const updateSort = (column: BfDataColumn<Row>) => {
    if (!column.sortable) return;
    const next: BfDataTableSort = {
      columnId: column.id,
      direction: sort?.columnId === column.id && sort.direction === "ascending" ? "descending" : "ascending",
    };
    setInternalSort(next);
    onSortChange?.(next);
  };

  const updateSelection = (rowId: string) => {
    if (selection === "none") return;
    if (selection === "single") {
      onSelectionChange?.(selectedSet.has(rowId) ? [] : [rowId]);
      return;
    }
    onSelectionChange?.(selectedSet.has(rowId) ? selectedRowIds.filter((id) => id !== rowId) : [...selectedRowIds, rowId]);
  };

  const selectableRows = sortedRows.filter((row) => isRowSelectable?.(row) ?? true);
  const allVisibleSelected = selectableRows.length > 0 && selectableRows.every((row) => selectedSet.has(getRowId(row)));
  const toggleAll = () => {
    const visibleIds = selectableRows.map(getRowId);
    if (allVisibleSelected) onSelectionChange?.(selectedRowIds.filter((id) => !visibleIds.includes(id)));
    else onSelectionChange?.([...new Set([...selectedRowIds, ...visibleIds])]);
  };

  const activate = (row: Row, event?: MouseEvent<HTMLTableRowElement>) => {
    onRowActivate?.(row);
    const href = getRowHref?.(row);
    if (!href) return;
    if (event && "metaKey" in event && (event.metaKey || event.ctrlKey)) window.open(href, "_blank", "noopener,noreferrer");
  };

  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;
  const rangeStart = pagination && pagination.total ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const rangeEnd = pagination ? Math.min(pagination.page * pagination.pageSize, pagination.total) : rows.length;
  const columnCount = columns.length + (selection !== "none" ? 1 : 0);
  const minimumTableWidth = columns.length * DATA_COLUMN_MIN_WIDTH + (selection === "none" ? 0 : SELECTION_COLUMN_WIDTH);
  const resolvedMinWidth = `max(${minWidth}, ${minimumTableWidth}px)`;

  return (
    <section className={`bds-data-table ${className}`.trim()} style={{ "--bds-data-table-min-width": resolvedMinWidth } as CSSProperties}>
      {toolbar && <div className="bds-data-table__toolbar">{toolbar}</div>}
      <div className="bds-data-table__scroller" style={{ maxHeight }}>
        <table className="bds-data-table__table" aria-label={ariaLabel} aria-busy={loading || undefined}>
          {caption && <caption>{caption}</caption>}
          <thead className={stickyHeader ? "is-sticky" : ""}>
            <tr>
              {selection !== "none" && <th className="bds-data-table__selection">
                {selection === "multiple" && <label className="bds-data-table__check-target"><input type="checkbox" aria-label="Select all eligible visible rows" checked={allVisibleSelected} disabled={!selectableRows.length} onChange={toggleAll} /></label>}
              </th>}
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={column.className}
                  data-align={column.align ?? "start"}
                  aria-sort={sort?.columnId === column.id ? sort.direction : undefined}
                  style={{ width: column.width }}
                >
                  {column.sortable ? (
                    <button type="button" onClick={() => updateSort(column)}>
                      <span>{column.header}</span>
                      {sort?.columnId === column.id ? sort.direction === "ascending" ? <ArrowUp size={14} /> : <ArrowDown size={14} /> : <ChevronsUpDown size={14} />}
                    </button>
                  ) : column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? Array.from({ length: loadingRowCount }, (_, index) => (
              <tr key={`loading-${index}`} aria-hidden="true">
                {Array.from({ length: columnCount }, (__, cellIndex) => <td key={cellIndex}><span className="bds-data-table__skeleton" /></td>)}
              </tr>
            )) : error ? (
              <tr><td colSpan={columnCount}><div className="bds-data-table__state bds-data-table__state--error">
                <strong>{error.title}</strong>
                {error.description && <p>{error.description}</p>}
                {error.action ?? (error.onRetry && <BfButton variant="secondary" icon={<RotateCcw size={14} />} onClick={error.onRetry}>Try again</BfButton>)}
              </div></td></tr>
            ) : !sortedRows.length ? (
              <tr><td colSpan={columnCount}><div className="bds-data-table__state">
                <strong>{emptyState.title}</strong>
                {emptyState.description && <p>{emptyState.description}</p>}
                {emptyState.action}
              </div></td></tr>
            ) : sortedRows.map((row) => {
              const rowId = getRowId(row);
              const interactive = Boolean(onRowActivate || getRowHref?.(row));
              const href = getRowHref?.(row);
              return (
                <tr
                  key={rowId}
                  data-selected={selectedSet.has(rowId) || undefined}
                  data-interactive={interactive || undefined}
                  onClick={(event) => {
                    if (!isInteractiveTarget(event.target)) activate(row, event);
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1 && !isInteractiveTarget(event.target) && href) window.open(href, "_blank", "noopener,noreferrer");
                  }}
                >
                  {selection !== "none" && <td className="bds-data-table__selection"><label className="bds-data-table__check-target"><input type="checkbox" aria-label={`Select row ${rowId}`} checked={selectedSet.has(rowId)} disabled={!(isRowSelectable?.(row) ?? true)} onChange={() => updateSelection(rowId)} /></label></td>}
                  {columns.map((column, index) => {
                    const content = readCell(column, row);
                    const actionLabel = `Open ${typeof content === "string" || typeof content === "number" ? content : rowId}`;
                    return <td key={column.id} className={column.className} data-align={column.align ?? "start"}>
                      {index === 0 && interactive ? href ? <a className="bds-data-table__row-action" href={href} aria-label={actionLabel} onClick={(event) => { event.stopPropagation(); if (onRowActivate) { event.preventDefault(); onRowActivate(row); } }}>{content}</a> : <button className="bds-data-table__row-action" type="button" aria-label={actionLabel} onClick={(event) => { event.stopPropagation(); onRowActivate?.(row); }}>{content}</button> : content}
                    </td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(footer || pagination) && <footer className="bds-data-table__footer">
        {footer ?? <span>Showing {rangeStart}–{rangeEnd} of {pagination?.total ?? rows.length}</span>}
        {pagination && <nav aria-label="Table pagination">
          <button type="button" aria-label="Previous page" disabled={pagination.page <= 1} onClick={() => pagination.onPageChange(pagination.page - 1)}><ArrowLeft size={15} /></button>
          <span>Page {pagination.page} of {totalPages}</span>
          <button type="button" aria-label="Next page" disabled={pagination.page >= totalPages} onClick={() => pagination.onPageChange(pagination.page + 1)}><ArrowRight size={15} /></button>
        </nav>}
      </footer>}
    </section>
  );
}
