/**
 * Tool-information and collection port for the Harness RPC endpoint.
 *
 * This is a read/adapt layer over the capability tool-access domain. Base,
 * dynamic and blacklist membership, their sources, activation effects and
 * persistence remain owned by `tool-access.ts`; the port only shapes domain
 * results for the wire and resolves per-tool registry metadata for detail.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  addBaseTools,
  addBlacklistTargets,
  activateToolTargets,
  deactivateToolTargets,
  removeBaseTools,
  removeBlacklistTargets,
  type ToolWriteResult as DomainToolWriteResult,
} from '../../capability/tool-access.ts';
import { createToolAccessView, listBaseTools, listBlacklist, queryToolAccess } from '../../capability/tool-access-view.ts';
import type {
  TargetsParams,
  ToolBaseListResult,
  ToolBlacklistListResult,
  ToolCatalogEntry,
  ToolCatalogResult,
  ToolDetail,
  ToolWriteResult,
  ToolsCatalogParams,
  ToolsDetailParams,
} from '../contract.ts';
import { RPC_ERROR } from '../protocol.ts';
import { RpcRequestError } from '../error.ts';

export type {
  ToolBaseListResult,
  ToolBlacklistListResult,
  ToolCatalogEntry,
  ToolCatalogResult,
  ToolDetail,
  ToolWriteResult,
};

export interface ToolPort {
  catalog(params: ToolsCatalogParams): ToolCatalogResult;
  detail(params: ToolsDetailParams): ToolDetail;
  baseAdd(params: TargetsParams): ToolWriteResult;
  baseRemove(params: TargetsParams): ToolWriteResult;
  baseList(): ToolBaseListResult;
  activate(params: TargetsParams): ToolWriteResult;
  deactivate(params: TargetsParams): ToolWriteResult;
  blacklistAdd(params: TargetsParams): ToolWriteResult;
  blacklistRemove(params: TargetsParams): ToolWriteResult;
  blacklistList(): ToolBlacklistListResult;
}

function branchOf(ctx: ExtensionContext): readonly unknown[] {
  return ctx.sessionManager.getBranch();
}

export function buildToolPort(api: ExtensionAPI, ctx: ExtensionContext): ToolPort {
  return {
    catalog(params: ToolsCatalogParams): ToolCatalogResult {
      const result = queryToolAccess(api, branchOf(ctx), api.getActiveTools(), {
        ...(params.includeActivatable === undefined ? {} : { includeActivatable: params.includeActivatable }),
        ...(params.includeUsable === undefined ? {} : { includeUsable: params.includeUsable }),
        ...(params.filter === undefined ? {} : { filter: params.filter }),
        ...(params.category === undefined ? {} : { category: params.category }),
      });
      const registered = new Map(api.getAllTools().map((tool) => [tool.name, tool]));
      const entries = result.entries.map((entry): ToolCatalogEntry => {
        const tool = registered.get(entry.name);
        return {
          name: entry.name,
          display: entry.display,
          description: entry.description,
          category: entry.category,
          group: entry.group,
          namespace: tool?.namespace?.name ?? null,
          exposure: tool?.exposure ?? null,
          registered: entry.registered,
          eligible: entry.eligible,
          base: entry.base,
          dynamic: entry.dynamic,
          active: entry.active,
          blacklisted: entry.blacklisted,
          blocked: entry.blocked,
          banOverridden: entry.banOverridden,
          blacklistSources: [...entry.blacklistSources],
          activatable: entry.activatable,
          usable: entry.usable,
          schemaMode: entry.schemaMode,
          configLazy: entry.configLazy,
          schemaWithheld: entry.schemaWithheld,
        };
      });
      return { entries, total: entries.length };
    },

    detail(params: ToolsDetailParams): ToolDetail {
      const name = params.name;
      const full = api.getAllTools().find((tool) => tool.name === name);
      if (full === undefined) {
        throw new RpcRequestError(RPC_ERROR.notFound, `No registered tool named "${name}".`);
      }
      const view = createToolAccessView(api, branchOf(ctx));
      const facts = view.factsFor(full);
      const listing = queryToolAccess(api, branchOf(ctx), api.getActiveTools(), {
        includeActivatable: true,
        includeUsable: true,
      }).entries.find((entry) => entry.name === name);
      return {
        name,
        description: typeof full.description === 'string' ? full.description : '',
        namespace: full.namespace?.name ?? null,
        exposure: full.exposure ?? null,
        parameters: full.parameters ?? null,
        promptGuidelines: Array.isArray(full.promptGuidelines) ? [...full.promptGuidelines] : null,
        registered: true,
        eligible: listing?.eligible ?? false,
        active: listing?.active ?? api.getActiveTools().includes(name),
        base: facts.base,
        dynamic: facts.dynamic,
        blacklisted: facts.blacklisted,
        blocked: facts.blocked,
        banOverridden: facts.banOverridden,
        blacklistSources: [...facts.blacklistSources],
        activatable: listing?.activatable ?? false,
        usable: listing?.usable ?? false,
        schemaMode: facts.schemaMode,
        configLazy: listing?.configLazy ?? false,
        schemaWithheld: listing?.schemaWithheld ?? false,
      };
    },

    baseAdd(params: TargetsParams): ToolWriteResult {
      return writeResult(addBaseTools(api, api, branchOf(ctx), params.targets));
    },

    baseRemove(params: TargetsParams): ToolWriteResult {
      return writeResult(removeBaseTools(api, api, branchOf(ctx), params.targets));
    },

    baseList(): ToolBaseListResult {
      return { targets: [...listBaseTools(api, branchOf(ctx))] };
    },

    activate(params: TargetsParams): ToolWriteResult {
      return writeResult(activateToolTargets(api, api, branchOf(ctx), params.targets));
    },

    deactivate(params: TargetsParams): ToolWriteResult {
      return writeResult(deactivateToolTargets(api, api, branchOf(ctx), params.targets));
    },

    blacklistAdd(params: TargetsParams): ToolWriteResult {
      return writeResult(addBlacklistTargets(api, api, branchOf(ctx), params.targets));
    },

    blacklistRemove(params: TargetsParams): ToolWriteResult {
      return writeResult(removeBlacklistTargets(api, api, branchOf(ctx), params.targets));
    },

    blacklistList(): ToolBlacklistListResult {
      return { entries: [...listBlacklist(api, branchOf(ctx))] };
    },
  };
}

/** The domain write result and the wire result share one structure; keep the copy explicit. */
function writeResult(result: DomainToolWriteResult): ToolWriteResult {
  return {
    action: result.action,
    changed: result.changed.map((change) => ({
      target: change.target,
      kind: change.kind,
      name: change.name,
      id: change.id,
      affectedTools: [...change.affectedTools],
    })),
    alreadySet: [...result.alreadySet],
    unresolved: [...result.unresolved],
    skipped: result.skipped.map((skip) => ({ target: skip.target, reason: skip.reason })),
    affectedTools: [...result.affectedTools],
    selected: [...result.selected],
    noSchema: [...result.noSchema],
    schema: [...result.schema],
    schemaWithheld: [...result.schemaWithheld],
    containers: result.containers.map((container) => ({
      target: container.target,
      kind: container.kind,
      name: container.name,
      id: container.id,
      explicit: container.explicit,
      members: [...container.members],
    })),
    excluded: [...result.excluded],
    rejected: result.rejected === null ? null : {
      code: result.rejected.code,
      targets: [...result.rejected.targets],
      members: [...result.rejected.members],
      ...(result.rejected.reason === undefined ? {} : { reason: result.rejected.reason }),
    },
    activated: [...result.activated],
    alreadyActive: [...result.alreadyActive],
    removedActive: [...result.removedActive],
    pendingCompaction: [...result.pendingCompaction],
    noticed: [...result.noticed],
    notRequested: [...result.notRequested],
    stillBlacklisted: [...result.stillBlacklisted],
    banOverridden: [...result.banOverridden],
    remainingSources: [...result.remainingSources],
    recordError: result.recordError,
    effectError: result.effectError,
  };
}
