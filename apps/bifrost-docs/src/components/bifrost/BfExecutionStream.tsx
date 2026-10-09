import "./execution.css";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, Check, Circle, Square, Terminal, TriangleAlert, X } from "lucide-react";
import { BfButton } from "./BfButton";

export type ExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type StreamConnection = "connected" | "reconnecting" | "disconnected";
export interface ExecutionEvent { id: string; time: string; level: "info" | "success" | "warning" | "error"; message: string }
export interface BfExecutionStreamProps {
  title: string;
  executionId: string;
  status: ExecutionStatus;
  connection: StreamConnection;
  events: ExecutionEvent[];
  onReconnect?: () => void;
}
const labels: Record<ExecutionStatus, string> = { queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled" };
const icons = { queued: Circle, running: Terminal, succeeded: Check, failed: X, cancelled: Square };

/** Presentational stream. The caller owns transport, ordering, retention and execution state. */
export function BfExecutionStream({ title, executionId, status, connection, events, onReconnect }: BfExecutionStreamProps) {
  const headingId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [isFollowing, setFollowing] = useState(true);
  const lastEventId = events[events.length - 1]?.id;
  const StatusIcon = icons[status];
  useEffect(() => {
    following.current = true;
    setFollowing(true);
  }, [executionId]);
  useEffect(() => {
    if (following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [lastEventId, executionId]);
  function followLatest() {
    following.current = true;
    setFollowing(true);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }
  const emptyMessage = status === "queued" ? "Waiting for execution to start." : status === "running" ? "Waiting for the first event." : "No output was recorded for this execution.";
  return (
    <section className="bds-execution" aria-labelledby={headingId} data-status={status} data-connection={connection}>
      <header className="bds-execution__header">
        <div><h2 id={headingId}>{title}</h2><code>{executionId}</code></div>
        <span className="bds-execution__status" role="status"><StatusIcon size={16} aria-hidden="true" />{labels[status]}</span>
      </header>
      <div className="bds-execution__bridge" aria-hidden="true"><span /></div>
      <div className="bds-execution__toolbar"><span><Terminal size={15} aria-hidden="true" /> Execution output</span><span>{events.length} events</span></div>
      {connection !== "connected" && <div className="bds-execution__connection" role="status"><TriangleAlert size={16} aria-hidden="true" /><p>{connection === "reconnecting" ? "Reconnecting. Output may be delayed." : "Connection lost. The execution may still be running."}</p>{onReconnect && connection === "disconnected" && <BfButton variant="secondary" onClick={onReconnect}>Reconnect</BfButton>}</div>}
      <div className="bds-execution__viewport" ref={viewport} role="region" aria-label="Execution events" tabIndex={0} onScroll={() => {
        const node = viewport.current;
        if (!node) return;
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        following.current = atBottom;
        setFollowing(atBottom);
      }}>
        {events.length ? <ol className="bds-execution__events">{events.map((event) => <li key={event.id} data-level={event.level}><time>{event.time}</time><span className="bds-execution__level">{event.level}</span><code>{event.message}</code></li>)}</ol> : <p className="bds-execution__empty">{emptyMessage}</p>}
      </div>
      <footer className="bds-execution__footer"><span>{!isFollowing ? "Reading earlier output" : connection !== "connected" ? "Showing received output" : status === "running" ? "Following live output" : "End of received output"}</span>{!isFollowing && <BfButton variant="ghost" onClick={followLatest} icon={<ArrowDown size={14} />}>Jump to latest</BfButton>}</footer>
    </section>
  );
}
