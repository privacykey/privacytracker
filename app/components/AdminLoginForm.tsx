"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import "./AdminLoginForm.css";

export default function AdminLoginForm() {
  const t = useTranslations("admin_login");
  const [token, setToken] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/admin-token/status", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("Status unavailable");
        }
        const status = await res.json();
        setConfigured(status.configured === true);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(t("unavailable"));
        }
      });
    return () => controller.abort();
  }, []);

  async function signIn(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const res = await fetch("/api/auth/admin-token/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setError(t(res.status === 429 ? "too_many" : "invalid"));
        return;
      }
      setToken("");
      window.location.assign("/dashboard");
    } catch {
      setError(t("unavailable"));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="admin-login">
      <section aria-labelledby="admin-login-title" className="admin-login-card">
        <p className="admin-login-brand">privacytracker</p>
        <h1 id="admin-login-title">{t("title")}</h1>
        <p>{t("description")}</p>
        {configured === false ? (
          <p role="status">{t("not_configured")}</p>
        ) : (
          <form onSubmit={signIn}>
            <label htmlFor="admin-token">{t("token_label")}</label>
            <input
              autoComplete="current-password"
              id="admin-token"
              onChange={(event) => setToken(event.target.value)}
              required
              type="password"
              value={token}
            />
            <button
              className="btn btn-primary"
              disabled={configured !== true || pending || !token.trim()}
              type="submit"
            >
              {t(pending ? "signing_in" : "sign_in")}
            </button>
          </form>
        )}
        <p aria-live="polite" role="status">
          {error}
        </p>
      </section>
    </main>
  );
}
