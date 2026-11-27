#!/usr/bin/env node
/**
 * Gate 0 spike: Cerbos HTTP checkResources + planResources + Prisma adapter.
 *
 * Prerequisites:
 *   .tools/cerbos/cerbos server --config=apps/api/cerbos/config.yaml
 *
 * Usage:
 *   node apps/api/scripts/spike-authz.mjs
 *
 * Exits non-zero on any assertion mismatch.
 */
import { performance } from "node:perf_hooks";

import { HTTP } from "@cerbos/http";
import { PlanKind, queryPlanToPrisma } from "@cerbos/orm-prisma";

const CERBOS_URL = process.env.CERBOS_URL ?? "http://127.0.0.1:3592";
const ACTION = "read";

const principals = {
  // A player has no establishment membership: only the global `player` group.
  player_a: {
    id: "user_a",
    roles: ["authenticated"],
    attr: {
      permissions: { "booking:read": "own" },
      isPlatformAdmin: false,
    },
  },
  staff_e1: {
    id: "user_staff_e1",
    roles: ["authenticated"],
    attr: {
      permissions: { "booking:read": "establishment" },
      establishmentId: "E1",
      membershipStatus: "active",
      isPlatformAdmin: false,
    },
  },
  platform_admin: {
    id: "user_admin",
    roles: ["authenticated"],
    attr: {
      permissions: { "booking:read": "platform" },
      establishmentId: "E1",
      membershipStatus: "active",
      isPlatformAdmin: true,
    },
  },
  anonymous: {
    id: "anonymous",
    roles: ["anonymous"],
    attr: {},
  },
};

const resources = {
  booking_a_e1: {
    kind: "booking",
    id: "booking_a",
    attr: { playerId: "user_a", establishmentId: "E1" },
  },
  booking_b_e1: {
    kind: "booking",
    id: "booking_b",
    attr: { playerId: "user_b", establishmentId: "E1" },
  },
  booking_b_e2: {
    kind: "booking",
    id: "booking_b_e2",
    attr: { playerId: "user_b", establishmentId: "E2" },
  },
};

const checks = [
  { name: "player_own_allow", principal: "player_a", resource: "booking_a_e1", expected: true },
  { name: "player_other_deny", principal: "player_a", resource: "booking_b_e1", expected: false },
  { name: "staff_e1_allow", principal: "staff_e1", resource: "booking_a_e1", expected: true },
  { name: "staff_e1_on_e2_deny", principal: "staff_e1", resource: "booking_b_e2", expected: false },
  { name: "platform_admin_allow", principal: "platform_admin", resource: "booking_b_e2", expected: true },
  { name: "anonymous_deny", principal: "anonymous", resource: "booking_a_e1", expected: false },
];

// Mapper keys required by the contract.
const prismaMapper = {
  "request.resource.attr.playerId": { field: "playerId" },
  "request.resource.attr.establishmentId": { field: "establishmentId" },
};

const plans = [
  {
    name: "player",
    principal: "player_a",
    expectedKind: PlanKind.CONDITIONAL,
    // @cerbos/orm-prisma 6.x renders equality as { equals: value }.
    expectedFilter: (filters) =>
      filters?.playerId?.equals === "user_a" && !("establishmentId" in filters),
  },
  {
    name: "staff",
    principal: "staff_e1",
    expectedKind: PlanKind.CONDITIONAL,
    // @cerbos/orm-prisma 6.x renders equality as { equals: value }.
    expectedFilter: (filters) =>
      filters?.establishmentId?.equals === "E1" && !("playerId" in filters),
  },
  {
    name: "platform_admin",
    principal: "platform_admin",
    expectedKind: PlanKind.ALWAYS_ALLOWED,
  },
  {
    name: "anonymous",
    principal: "anonymous",
    expectedKind: PlanKind.ALWAYS_DENIED,
  },
];

function percentile(sorted, p) {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

async function main() {
  const cerbos = new HTTP(CERBOS_URL);
  const output = {
    ok: true,
    cerbosUrl: CERBOS_URL,
    checks: [],
    plans: [],
    latencyMs: null,
  };

  // --- checkResources -------------------------------------------------------
  for (const scenario of checks) {
    const response = await cerbos.checkResources({
      principal: principals[scenario.principal],
      resources: [
        {
          resource: resources[scenario.resource],
          actions: [ACTION],
        },
      ],
    });

    const actual = response.results[0]?.isAllowed(ACTION);
    const pass = actual === scenario.expected;
    output.checks.push({
      name: scenario.name,
      principal: scenario.principal,
      resource: scenario.resource,
      expected: scenario.expected,
      actual,
      pass,
    });
    if (!pass) output.ok = false;
  }

  // --- planResources + @cerbos/orm-prisma -----------------------------------
  for (const scenario of plans) {
    const plan = await cerbos.planResources({
      principal: principals[scenario.principal],
      resource: { kind: "booking" },
      action: ACTION,
    });

    const adapted = queryPlanToPrisma({ queryPlan: plan, mapper: prismaMapper });
    const kindMatches = plan.kind === scenario.expectedKind && adapted.kind === scenario.expectedKind;
    const filterMatches =
      scenario.expectedKind !== PlanKind.CONDITIONAL ||
      (adapted.kind === PlanKind.CONDITIONAL && scenario.expectedFilter(adapted.filters));
    const pass = kindMatches && filterMatches;

    output.plans.push({
      name: scenario.name,
      expectedKind: scenario.expectedKind,
      planKind: plan.kind,
      prismaKind: adapted.kind,
      filters: adapted.kind === PlanKind.CONDITIONAL ? adapted.filters : null,
      pass,
    });
    if (!pass) output.ok = false;
  }

  // --- latency: 100 sequential checkResources calls -------------------------
  const latencyRequest = {
    principal: principals.staff_e1,
    resources: [{ resource: resources.booking_a_e1, actions: [ACTION] }],
  };

  for (let i = 0; i < 5; i += 1) {
    await cerbos.checkResources(latencyRequest);
  }

  const timings = [];
  for (let i = 0; i < 100; i += 1) {
    const started = performance.now();
    const response = await cerbos.checkResources(latencyRequest);
    timings.push(performance.now() - started);
    if (response.results[0]?.isAllowed(ACTION) !== true) {
      output.ok = false;
      output.latencyError = `unexpected deny on iteration ${i + 1}`;
    }
  }

  timings.sort((a, b) => a - b);
  output.latencyMs = {
    samples: timings.length,
    p50: Number(percentile(timings, 50).toFixed(2)),
    p95: Number(percentile(timings, 95).toFixed(2)),
  };

  console.log(JSON.stringify(output));
  process.exit(output.ok ? 0 : 1);
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      ok: false,
      cerbosUrl: CERBOS_URL,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }),
  );
  process.exit(1);
});
