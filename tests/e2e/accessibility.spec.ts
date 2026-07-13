import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const axePath = path.join(process.cwd(), "node_modules/axe-core/axe.min.js");
const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;
const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

interface AxeNode {
  failureSummary?: string;
  html: string;
  target: unknown[];
}

interface AxeViolation {
  help: string;
  helpUrl: string;
  id: string;
  impact: string | null;
  nodes: AxeNode[];
}

function formatViolations(route: string, violations: AxeViolation[]): string {
  const details = violations
    .map((violation) => {
      const nodes = violation.nodes
        .map(
          (node) =>
            `    ${JSON.stringify(node.target)}\n      ${node.html}\n      ${node.failureSummary ?? ""}`
        )
        .join("\n");

      return `${violation.id} (${violation.impact ?? "unknown"}): ${violation.help}\n  ${violation.helpUrl}\n${nodes}`;
    })
    .join("\n\n");

  return `${route} has ${violations.length} WCAG A/AA violation(s):\n\n${details}`;
}

async function expectRouteToBeAccessible(
  page: Page,
  route: string,
  { scanCoachmark = false }: { scanCoachmark?: boolean } = {}
): Promise<void> {
  await page.goto(route);
  await expect(page.locator("main").first()).toBeVisible();
  await page.addScriptTag({ path: axePath });

  if (scanCoachmark) {
    const coachmark = page.locator(".coachmark-tooltip");
    await expect(coachmark).toBeVisible();
    await page.waitForTimeout(250);
    await expectContextToBeAccessible(
      page,
      `${route} coachmark`,
      ".coachmark-tooltip"
    );
    await coachmark.getByRole("button", { name: "Skip tour" }).click();
    await expect(coachmark).toBeHidden();
  }

  // Several first-paint surfaces use sub-300ms opacity transitions. Scan
  // the settled UI so temporary animation frames do not distort contrast.
  await page.waitForTimeout(300);
  await expectContextToBeAccessible(page, route);
}

async function expectContextToBeAccessible(
  page: Page,
  label: string,
  contextSelector?: string
): Promise<void> {
  const violations = await page.evaluate(async (contextSelector) => {
    const axe = (
      window as typeof window & {
        axe: {
          run: (
            context: Document | Element,
            options: {
              resultTypes: string[];
              runOnly: { type: string; values: string[] };
            }
          ) => Promise<{ violations: AxeViolation[] }>;
        };
      }
    ).axe;
    const scanTarget = contextSelector
      ? document.querySelector(contextSelector)
      : document;
    if (!scanTarget) {
      throw new Error(`Missing axe scan target: ${contextSelector}`);
    }

    const results = await axe.run(scanTarget, {
      resultTypes: ["violations"],
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22a",
          "wcag22aa",
        ],
      },
    });

    return results.violations;
  }, contextSelector ?? null);

  expect(violations, formatViolations(label, violations)).toEqual([]);
}

browserFlow(
  "representative routes have no automated WCAG A/AA violations",
  async ({ page, request }) => {
    const reset = await request.post("/api/reset", {
      headers: sameOriginHeaders,
    });
    await expect(reset).toBeOK();

    await expectRouteToBeAccessible(page, "/welcome");
    await expectRouteToBeAccessible(page, "/onboard?preview=fresh");

    const focus = await request.post("/api/focus", {
      headers: sameOriginHeaders,
      data: {
        accessibility: true,
        audience: "self",
        cleanup: true,
        minimal: false,
        monitor: true,
      },
    });
    await expect(focus).toBeOK();

    const seed = await request.post(
      "/api/dev/seed-sample-data?source=canned&limit=2",
      { headers: sameOriginHeaders }
    );
    await expect(seed).toBeOK();

    const appsResponse = await request.get("/api/apps");
    await expect(appsResponse).toBeOK();
    const apps = (await appsResponse.json()) as Array<{ id: string }>;
    expect(apps.length).toBeGreaterThan(0);

    const populatedRoutes = [
      "/dashboard",
      "/dashboard/apps",
      `/apps/${apps[0].id}`,
      "/dashboard/privacy",
      "/dashboard/settings",
    ];

    for (const route of populatedRoutes) {
      await expectRouteToBeAccessible(page, route, {
        scanCoachmark: route === "/dashboard",
      });
    }
  }
);
