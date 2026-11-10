/**
 * Tool-information and permission port for the Harness RPC endpoint.
 *
 * This is a read/adapt layer over the existing capability and tool-permission
 * domains; it never re-implements eligibility, activation or permission rules.
 * It reuses the capability catalogue, scope eligibility, and the unified
 * three-state permission module (`tool-permission.ts`) that replaced the former
 * blacklist domain.
 *
 * The per-tool status keeps independent runtime facts (`registered`,
 * `eligible`, `active`) and adds the mutually exclusive four-state `permission`
 * plus `managed`. `active` is not implied by `permission`: a managed tool
 * reports `enabled`/`disabled` while `active` still reflects the live active
 * set. `eligible` stays scope-level and is not folded into permission.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createCapabilityCatalog, type CapabilityCategory } from '../../capability/catalog.ts';
import { createEligibleToolCatalog } from '../../capability/tool-catalog.ts';
import { enableCapabilityTargets, type EnableResult } from '../../capability/enable.ts';
import {
  explicitlyDisabled,
  queryToolPermissions,
  resolveToolPermission,
  setToolPermission,
  resetToolPermission,
  ToolPermissionQueryError,
  type ToolPermissionInfo,
  type ToolPermissionQueryResult,
  type ToolPermissionSetResult,
  type ToolPermissionResetResult,
  type ToolPermissionState,
} from '../../capability/tool-permission.ts';
import { RPC_ERROR } from '../protocol.ts';
import { RpcRequestError } from '../error.ts';
import { asRecord, optionalString, requireString, requireStringArray } from '../util.ts';

/** The independent runtime facts plus the unified permission state. */
export interface ToolStatus {
  readonly registered: boolean;
  readonly eligible: boolean;
  readonly active: boolean;
  /** Mutually exclusive: enabled / disabled / active / inactive. */
  readonly permission: ToolPermissionState;
  /** Whether an explicit management entry resolves for this tool. */
  readonly managed: boolean;
}

export interface ToolCatalogEntry extends ToolStatus {
  readonly name: string;
  readonly display: string;
  readonly description: string;
  readonly category: CapabilityCategory;
  readonly group: string;
  readonly namespace: string | null;
  readonly exposure: string | null;
}

export interface ToolDetail extends ToolStatus {
  readonly name: string;
  readonly description: string;
  readonly namespace: string | null;
  readonly exposure: string | null;
  readonly parameters: unknown;
  readonly promptGuidelines: readonly string[] | null;
}

export interface ToolCatalogResult {
  readonly entries: readonly ToolCatalogEntry[];
  readonly total: number;
}

export interface ToolPort {
  catalog(params: unknown): ToolCatalogResult;
  detail(params: unknown): ToolDetail;
  enable(params: unknown): EnableResult;
  permissionQuery(params: unknown): ToolPermissionQueryResult;
  permissionEnable(params: unknown): ToolPermissionSetResult;
  permissionDisable(params: unknown): ToolPermissionSetResult;
  permissionReset(params: unknown): ToolPermissionResetResult;
}

/** One consistent read of every state source for a single request. */
interface StateSnapshot {
  readonly registered: Map<string, { namespace?: { name: string } | undefined; exposure?: string | undefined }>;
  readonly eligible: ReadonlySet<string>;
  readonly active: ReadonlySet<string>;
  readonly permission: ReadonlyMap<string, ToolPermissionInfo>;
}

function snapshot(api: ExtensionAPI, ctx: ExtensionContext): StateSnapshot {
  const branch = ctx.sessionManager.getBranch();
  const active = api.getActiveTools();
  const registered = new Map(api.getAllTools().map((tool) => [tool.name, tool]));
  // Derive every registered tool's state directly; a filtered query (the
  // default is enabled+active) would hide disabled/inactive tools.
  const permission = new Map<string, ToolPermissionInfo>();
  for (const name of registered.keys()) {
    permission.set(name, resolveToolPermission(api, branch, name, active));
  }
  return {
    registered,
    eligible: createEligibleToolCatalog(api, {
      disabled: (name) => explicitlyDisabled(api, branch, name),
    }).names,
    active: new Set(active),
    permission,
  };
}

function statusOf(name: string, state: StateSnapshot): ToolStatus {
  const info = state.permission.get(name);
  return {
    registered: info?.registered ?? state.registered.has(name),
    eligible: state.eligible.has(name),
    active: info?.active ?? state.active.has(name),
    permission: info?.state ?? 'inactive',
    managed: info?.managed ?? false,
  };
}

function isDisabled(name: string, state: StateSnapshot): boolean {
  return state.permission.get(name)?.state === 'disabled';
}

export function buildToolPort(api: ExtensionAPI, ctx: ExtensionContext): ToolPort {
  return {
    catalog(params: unknown): ToolCatalogResult {
      const input = asRecord(params);
      const filter = optionalString(input.filter);
      const category = optionalString(input.category) as CapabilityCategory | undefined;
      const state = snapshot(api, ctx);
      // The available catalogue excludes explicitly disabled tools by default;
      // `detail` still reports them so a client can manage the restriction.
      const view = createCapabilityCatalog(api, {
        disabled: (name: string) => isDisabled(name, state),
        ...(filter === undefined ? {} : { filter }),
        ...(category === undefined ? {} : { category }),
      });
      const entries = view.entries.map((entry): ToolCatalogEntry => {
        const info = state.registered.get(entry.name);
        return {
          name: entry.name,
          display: entry.display,
          description: entry.description,
          category: entry.category,
          group: entry.group,
          namespace: info?.namespace?.name ?? null,
          exposure: info?.exposure ?? null,
          ...statusOf(entry.name, state),
        };
      });
      return { entries, total: entries.length };
    },

    detail(params: unknown): ToolDetail {
      const name = requireString(asRecord(params).name, 'name');
      const state = snapshot(api, ctx);
      const info = state.registered.get(name);
      if (info === undefined) {
        throw new RpcRequestError(RPC_ERROR.notFound, `No registered tool named "${name}".`);
      }
      const full = api.getAllTools().find((tool) => tool.name === name);
      return {
        name,
        description: typeof full?.description === 'string' ? full.description : '',
        namespace: info.namespace?.name ?? null,
        exposure: info.exposure ?? null,
        parameters: full?.parameters ?? null,
        promptGuidelines: Array.isArray(full?.promptGuidelines) ? full.promptGuidelines : null,
        ...statusOf(name, state),
      };
    },

    // The user control plane: capability user-enable keeps its own activation and
    // branch record semantics; the model never reaches this path.
    enable(params: unknown) {
      const targets = requireStringArray(asRecord(params).targets, 'targets');
      return enableCapabilityTargets(api, targets, { branch: ctx.sessionManager.getBranch() });
    },

    permissionQuery(params: unknown): ToolPermissionQueryResult {
      const expression = optionalString(asRecord(params).expr);
      try {
        // No source/entry/explain: the shared domain answers with derived state.
        return queryToolPermissions(api, ctx.sessionManager.getBranch(), api.getActiveTools(), expression);
      } catch (error) {
        if (error instanceof ToolPermissionQueryError) {
          throw new RpcRequestError(RPC_ERROR.invalidRequest, error.message);
        }
        throw error;
      }
    },

    permissionEnable(params: unknown): ToolPermissionSetResult {
      const targets = requireStringArray(asRecord(params).targets, 'targets');
      return setToolPermission(api, api, ctx.sessionManager.getBranch(), targets, 'enabled');
    },

    permissionDisable(params: unknown): ToolPermissionSetResult {
      const targets = requireStringArray(asRecord(params).targets, 'targets');
      return setToolPermission(api, api, ctx.sessionManager.getBranch(), targets, 'disabled');
    },

    permissionReset(params: unknown): ToolPermissionResetResult {
      const targets = requireStringArray(asRecord(params).targets, 'targets');
      return resetToolPermission(api, api, ctx.sessionManager.getBranch(), targets);
    },
  };
}
