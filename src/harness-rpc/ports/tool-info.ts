/**
 * Tool-information and permission port for the Harness RPC endpoint.
 *
 * This is a read/adapt layer over the existing capability and tool-permission
 * domains; it never re-implements eligibility, activation or permission rules.
 * It reuses the capability catalogue, scope eligibility, and the unified
 * three-state permission module (`tool-permission.ts`).
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createCapabilityCatalog } from '../../capability/catalog.ts';
import { createEligibleToolCatalog } from '../../capability/tool-catalog.ts';
import { enableCapabilityTargets, type EnableResult } from '../../capability/enable.ts';
import {
  createToolPermissionResolver,
  queryToolPermissions,
  setToolPermission,
  resetToolPermission,
  ToolPermissionQueryError,
  type ToolPermissionInfo,
  type ToolPermissionQueryResult,
  type ToolPermissionSetResult,
  type ToolPermissionResetResult,
} from '../../capability/tool-permission.ts';
import type {
  PermissionQueryParams,
  TargetsParams,
  ToolCatalogEntry,
  ToolCatalogResult,
  ToolDetail,
  ToolStatus,
  ToolsCatalogParams,
  ToolsDetailParams,
} from '../contract.ts';
import { RPC_ERROR } from '../protocol.ts';
import { RpcRequestError } from '../error.ts';

export type { ToolStatus, ToolCatalogEntry, ToolCatalogResult, ToolDetail };

export interface ToolPort {
  catalog(params: ToolsCatalogParams): ToolCatalogResult;
  detail(params: ToolsDetailParams): ToolDetail;
  enable(params: TargetsParams): EnableResult;
  permissionQuery(params: PermissionQueryParams): ToolPermissionQueryResult;
  permissionEnable(params: TargetsParams): ToolPermissionSetResult;
  permissionDisable(params: TargetsParams): ToolPermissionSetResult;
  permissionReset(params: TargetsParams): ToolPermissionResetResult;
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
  const allTools = api.getAllTools();
  const registered = new Map(allTools.map((tool) => [tool.name, tool]));
  const resolver = createToolPermissionResolver(api, allTools, branch);
  const activeSet = new Set(active);
  const permission = new Map<string, ToolPermissionInfo>();
  for (const tool of allTools) {
    permission.set(tool.name, resolver.resolveFor(tool, activeSet.has(tool.name)));
  }
  return {
    registered,
    eligible: createEligibleToolCatalog(api, {
      disabled: (name) => resolver.disabled(name),
    }).names,
    active: activeSet,
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

export function buildToolPort(api: ExtensionAPI, ctx: ExtensionContext): ToolPort {
  return {
    catalog(params: ToolsCatalogParams): ToolCatalogResult {
      const state = snapshot(api, ctx);
      // Match the user picker: disabled entries remain visible for permission management.
      const view = createCapabilityCatalog(api, {
        ...(params.filter === undefined ? {} : { filter: params.filter }),
        ...(params.category === undefined ? {} : { category: params.category }),
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

    detail(params: ToolsDetailParams): ToolDetail {
      const name = params.name;
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
    enable(params: TargetsParams): EnableResult {
      return enableCapabilityTargets(api, params.targets, { branch: ctx.sessionManager.getBranch() });
    },

    permissionQuery(params: PermissionQueryParams): ToolPermissionQueryResult {
      try {
        // No source/entry/explain: the shared domain answers with derived state.
        return queryToolPermissions(api, ctx.sessionManager.getBranch(), api.getActiveTools(), params.expr);
      } catch (error) {
        if (error instanceof ToolPermissionQueryError) {
          throw new RpcRequestError(RPC_ERROR.invalidRequest, error.message);
        }
        throw error;
      }
    },

    permissionEnable(params: TargetsParams): ToolPermissionSetResult {
      return setToolPermission(api, api, ctx.sessionManager.getBranch(), params.targets, 'enabled');
    },

    permissionDisable(params: TargetsParams): ToolPermissionSetResult {
      return setToolPermission(api, api, ctx.sessionManager.getBranch(), params.targets, 'disabled');
    },

    permissionReset(params: TargetsParams): ToolPermissionResetResult {
      return resetToolPermission(api, api, ctx.sessionManager.getBranch(), params.targets);
    },
  };
}
