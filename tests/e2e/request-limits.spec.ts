import http from "node:http";
import { expect, test } from "@playwright/test";

test("oversized chunked login is rejected before the upload finishes", async ({
  baseURL,
}) => {
  const result = await new Promise<{
    status: number;
    sent: number;
    ended: boolean;
  }>((resolve, reject) => {
    let sent = 0;
    let timer: ReturnType<typeof setInterval>;
    const req = http.request(
      `${baseURL}/api/auth/admin-token/login`,
      {
        method: "POST",
        headers: {
          Origin: baseURL!,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      },
      (res) => {
        clearInterval(timer);
        const status = res.statusCode ?? 0;
        const ended = req.writableEnded;
        res.resume();
        res.on("end", () => {
          req.destroy();
          resolve({ status, sent, ended });
        });
      }
    );
    req.setTimeout(5000, () =>
      req.destroy(new Error("Upload did not reject promptly"))
    );
    req.on("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
    timer = setInterval(() => {
      sent += 1;
      req.write(Buffer.alloc(4096, 32));
      if (sent === 128) {
        clearInterval(timer);
        req.end();
      }
    }, 10);
  });
  expect(result.status).toBe(413);
  expect(result.sent).toBeLessThan(128);
  expect(result.ended).toBe(false);
});

test("authenticated backup previews can exceed Next's default clone limit", async ({
  request,
}) => {
  const exported = await request.get("/api/backup/export");
  await expect(exported).toBeOK();
  const backup = await exported.json();
  // An ignored extra field makes the otherwise valid backup exceed 10 MiB.
  const response = await request.post("/api/backup/preview", {
    data: { ...backup, transportTestPadding: "x".repeat(11 * 1024 * 1024) },
  });
  await expect(response).toBeOK();
});
