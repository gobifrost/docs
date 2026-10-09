declare module "bifrost" {
  import type { ComponentType, ReactNode } from "react";

  export const BifrostHeader: ComponentType<{
    action?: ReactNode;
    className?: string;
    logo?: string | null;
    title?: string;
  }>;

  export const BifrostProvider: ComponentType<{
    appId?: string | null;
    solutionId?: string | null;
    baseUrl: string;
    children: ReactNode;
    onLogout?: () => void;
    orgScope?: string | null;
    supportsTheme?: boolean;
    theme?: "light" | "dark";
    token: string;
  }>;

  export function useTable(
    name: string,
    query?: Record<string, unknown>,
  ): {
    rows: Array<Record<string, unknown> & { id: string }>;
    total: number;
    totalPages: number;
    loading: boolean;
    error: Error | null;
  };

  export function useBifrostContext(): {
    appId: string | null;
    solutionId?: string | null;
    authedFetch: (input: string, init?: RequestInit) => Promise<Response>;
    baseUrl: string;
    orgScope: string | null;
    token: string;
  };

  export class TableAccessDeniedError extends Error {}
  export class TableNotFoundError extends Error {}
  export class FileAccessDeniedError extends Error {}
  export class FileNotFoundError extends Error {}
  export class FilePolicyError extends Error {}
  export function useFiles(...args: unknown[]): unknown;
  export function useInfiniteTable(...args: unknown[]): unknown;
  export function useWorkflow(...args: unknown[]): unknown;

  export const tables: {
    get: (table: string, id: string, scope?: string | null) => Promise<{
      table_id?: string;
      id: string;
      data?: Record<string, unknown>;
      created_at?: string;
      updated_at?: string;
    } | null>;
    query: (table: string, query?: Record<string, unknown>, scope?: string | null) => Promise<{
      table_id?: string;
      documents: Array<{
        id: string;
        data?: Record<string, unknown>;
        created_at?: string;
        updated_at?: string;
      }>;
      total?: number;
    }>;
    subscribe: (tableId: string, filter: unknown | null, onEvent: (event: { type: string }) => void, onReconnect: () => void) => () => void;
    insert: (table: string, data: Record<string, unknown>, scope?: string | null) => Promise<{ id: string; data?: Record<string, unknown> }>;
    update: (table: string, id: string, data: Record<string, unknown>, scope?: string | null) => Promise<{ id: string; data?: Record<string, unknown> } | null>;
    delete: (table: string, id: string, scope?: string | null) => Promise<boolean>;
  };

  export const files: {
    download: (path: string, options?: { location?: string; scope?: string | null }) => Promise<Blob>;
    upload: (path: string, content: Blob | ArrayBuffer | string, options?: { location?: string; scope?: string | null; contentType?: string }) => Promise<unknown>;
    delete: (path: string, options?: { location?: string; scope?: string | null }) => Promise<void>;
  };

  export function useWorkflowMutation<TData = unknown>(
    ref: string,
  ): {
    data?: TData;
    error?: Error | null;
    loading: boolean;
    mutate: (params?: Record<string, unknown>) => Promise<TData>;
  };

  export function useWorkflowQuery<TData = unknown>(
    ref: string,
    params?: Record<string, unknown>,
  ): {
    data?: TData;
    error?: Error | null;
    loading: boolean;
    refresh: (params?: Record<string, unknown>) => Promise<void>;
  };
}
