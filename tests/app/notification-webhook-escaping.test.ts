/**
 * App Store app names are chosen by the app's developer, so a chat
 * webhook payload must never let one add a link, a mention or formatting
 * to the message. Each chat format escapes its own markup, Discord turns
 * every mention off, and the generic JSON format carries the text as-is.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeDiscordText,
  escapeMarkdownText,
  escapeSlackText,
  postImmediateWebhook,
} from "../../lib/notification-webhooks";
import { setSetting } from "../../lib/scheduler";

const HOSTILE =
  "Evil <!channel> @everyone @here [Update now](https://x.test) *b* & <@123>";

const originalFetch = global.fetch;
let posted: Record<string, any>[] = [];

test.beforeEach(() => {
  posted = [];
  global.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    posted.push(JSON.parse(String(init?.body)));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  setSetting("notification_webhook_url", "https://hooks.example.com/hook");
  setSetting("notification_webhook_frequency", "immediate");
});

test.afterEach(() => {
  global.fetch = originalFetch;
  setSetting("notification_webhook_url", "");
});

async function postAs(format: string) {
  setSetting("notification_webhook_format", format);
  await postImmediateWebhook({
    appName: HOSTILE,
    summary: "2 privacy changes",
    createdAt: 1,
  });
  assert.equal(posted.length, 1, format);
  return posted[0];
}

test("Slack payloads escape &, < and >", async () => {
  const body = await postAs("slack");
  assert.equal(
    body.text,
    "📱 Evil &lt;!channel&gt; @everyone @here [Update now](https://x.test) *b* &amp; &lt;@123&gt;: 2 privacy changes\n2 privacy changes"
  );
});

test("Discord payloads escape Markdown, break @everyone and @here, and allow no mentions", async () => {
  const body = await postAs("discord");
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(
    body.content,
    "📱 Evil \\<!channel\\> @\u200beveryone @\u200bhere \\[Update now\\]\\(https://x.test\\) \\*b\\* \\& \\<@123\\>: 2 privacy changes\n2 privacy changes"
  );
});

test("Teams payloads escape Markdown in the title, summary and text", async () => {
  const body = await postAs("teams");
  const title =
    "📱 Evil \\<!channel\\> @everyone @here \\[Update now\\]\\(https://x.test\\) \\*b\\* \\& \\<@123\\>: 2 privacy changes";
  assert.equal(body.title, title);
  assert.equal(body.summary, title);
  assert.equal(body.text, "2 privacy changes");
});

test("generic payloads carry the app name unchanged", async () => {
  const body = await postAs("generic");
  assert.equal(body.notifications[0].appName, HOSTILE);
});

test("the escape helpers cover every special character", () => {
  assert.equal(escapeSlackText("a&b<c>d"), "a&amp;b&lt;c&gt;d");
  assert.equal(
    escapeMarkdownText("\\`*_~|<>[]()#&-"),
    "\\\\\\`\\*\\_\\~\\|\\<\\>\\[\\]\\(\\)\\#\\&\\-"
  );
  assert.equal(
    escapeDiscordText("@@here @everyone"),
    "@@\u200bhere @\u200beveryone"
  );
  assert.equal(escapeDiscordText("plain text"), "plain text");
});
