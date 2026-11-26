import React, { useEffect, useState } from "react";
import { Check, LogOut, Loader2, Monitor, Moon, Sun, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";

import PageContainer from "@/components/layout/PageContainer";
import Section from "@/components/settings/Section";
import { applyTheme, getTheme, setTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEMES = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

export default function Settings() {
  const [user, setUser] = useState(null);
  const [fullName, setFullName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [theme, setThemeChoice] = useState(getTheme());
  const [keyProviders, setKeyProviders] = useState([]);
  const [savedKeys, setSavedKeys] = useState([]);
  const [keyInputs, setKeyInputs] = useState({});
  const [keyBusy, setKeyBusy] = useState("");
  const [keyError, setKeyError] = useState("");
  const [keyNotice, setKeyNotice] = useState("");
  const [plan, setPlan] = useState({ plan: "free", hasOwnKey: false });

  useEffect(() => {
    api.auth
      .me()
      .then((me) => {
        setUser(me);
        setFullName(me?.full_name || "");
      })
      .catch(() => setError("Your account details couldn't be loaded."));
  }, []);

  useEffect(() => {
    api.settings.get()
      .then(({ preferences }) => {
        if (THEMES.some((item) => item.value === preferences.theme)) {
          setThemeChoice(preferences.theme);
          setTheme(preferences.theme);
          applyTheme(preferences.theme);
        }
      })
      .catch(() => setSettingsError("Your saved appearance settings couldn't be loaded."));
  }, []);

  useEffect(() => {
    Promise.all([api.settings.keys(), api.settings.plan()])
      .then(([keys, currentPlan]) => {
        setKeyProviders(keys.providers || []);
        setSavedKeys(keys.keys || []);
        setPlan(currentPlan);
      })
      .catch(() => setKeyError("Your key and plan settings couldn't be loaded."));
  }, []);

  const saveProfile = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const updated = await api.auth.updateProfile(fullName.trim());
      setUser(updated);
      setSaved(true);
    } catch {
      setError("Your changes couldn't be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const chooseTheme = async (next) => {
    setThemeChoice(next);
    setTheme(next);
    applyTheme(next);
    setSettingsError("");
    try {
      await api.settings.update({ theme: next });
    } catch (requestError) {
      setSettingsError(requestError.message || "Your appearance preference couldn't be saved.");
    }
  };

  const saveKey = async (provider) => {
    const apiKey = keyInputs[provider] || "";
    if (!apiKey.trim() || keyBusy) return;
    setKeyBusy(provider);
    setKeyError("");
    setKeyNotice("");
    try {
      const saved = await api.settings.saveKey({ provider, apiKey });
      setSavedKeys((current) => [...current.filter((item) => item.provider !== provider), saved]);
      setKeyInputs((current) => ({ ...current, [provider]: "" }));
      setPlan((current) => ({ ...current, hasOwnKey: true }));
      setKeyNotice(`${keyProviders.find((item) => item.id === provider)?.name || provider} key saved securely.`);
    } catch (requestError) {
      setKeyError(requestError.message || "The API key couldn't be saved.");
    } finally {
      setKeyBusy("");
    }
  };

  const deleteKey = async (provider) => {
    setKeyBusy(provider);
    setKeyError("");
    setKeyNotice("");
    try {
      await api.settings.deleteKey(provider);
      const next = savedKeys.filter((item) => item.provider !== provider);
      setSavedKeys(next);
      setPlan((current) => ({ ...current, hasOwnKey: next.length > 0 }));
      setKeyNotice("The saved key was removed.");
    } catch (requestError) {
      setKeyError(requestError.message || "The API key couldn't be removed.");
    } finally {
      setKeyBusy("");
    }
  };

  return (
    <PageContainer
      title="Settings"
      description="Your account and how Biz looks and behaves."
    >
      <Section title="Profile" description="The name shown on your account.">
        <div className="max-w-md space-y-4">
          <div>
            <label
              htmlFor="full-name"
              className="mb-1.5 block text-[12.5px] font-medium text-foreground/80"
            >
              Full name
            </label>
            <input
              id="full-name"
              value={fullName}
              onChange={(event) => {
                setFullName(event.target.value);
                setSaved(false);
              }}
              placeholder="Your name"
              className="h-10 w-full rounded-xl border border-border/80 bg-transparent px-3.5 text-[14px] text-foreground placeholder:text-muted-foreground/70 focus:border-border focus:outline-none focus:ring-2 focus:ring-ring/15"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-foreground/80">
              Email
            </label>
            <div className="flex h-10 items-center rounded-xl border border-border/60 bg-muted/40 px-3.5 text-[14px] text-muted-foreground">
              {user?.email || "—"}
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground/80">
              Your email is used to sign in and can't be changed here.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={saveProfile}
              disabled={saving || !fullName.trim() || fullName.trim() === (user?.full_name || "")}
              className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />}
              Save changes
            </button>
            {saved && (
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <Check className="h-3.5 w-3.5" strokeWidth={2} />
                Saved
              </span>
            )}
          </div>

          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        </div>
      </Section>

      <Section title="Appearance" description="Biz follows your preference across sessions.">
        <div className="grid max-w-md grid-cols-3 gap-2">
          {THEMES.map(({ value, label, icon: Icon }) => {
            const active = theme === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => chooseTheme(value)}
                className={cn(
                  "flex flex-col items-start gap-2 rounded-xl border px-3.5 py-3 text-[13px] transition-colors",
                  active
                    ? "border-primary/40 bg-primary/[0.07] text-foreground"
                    : "border-border/80 text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={1.7} />
                {label}
              </button>
            );
          })}
        </div>
        {settingsError && <p className="mt-3 text-[12.5px] text-destructive">{settingsError}</p>}
      </Section>

      <Section title="Your API keys (BYOK)" description="Keys are encrypted on the server and never shown again after saving.">
        <div className="max-w-xl space-y-3">
          {keyProviders.map((provider) => {
            const existing = savedKeys.find((item) => item.provider === provider.id);
            return (
              <div key={provider.id} className="rounded-xl border border-border/70 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-medium">{provider.name}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {existing ? `Saved key ending in ${existing.keySuffix}` : "No personal key saved"}
                    </p>
                  </div>
                  {existing && (
                    <button
                      type="button"
                      disabled={Boolean(keyBusy)}
                      onClick={() => deleteKey(provider.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
                    >
                      {keyBusy === provider.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      Remove
                    </button>
                  )}
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={keyInputs[provider.id] || ""}
                    onChange={(event) => setKeyInputs((current) => ({ ...current, [provider.id]: event.target.value }))}
                    placeholder={`Paste your ${provider.name} API key`}
                    className="h-10 min-w-0 flex-1 rounded-xl border border-border/80 bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/20"
                  />
                  <button
                    type="button"
                    disabled={!keyInputs[provider.id]?.trim() || Boolean(keyBusy)}
                    onClick={() => saveKey(provider.id)}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {keyBusy === provider.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Save key
                  </button>
                </div>
              </div>
            );
          })}
          {keyError && <p role="alert" className="text-xs text-destructive">{keyError}</p>}
          {keyNotice && <p role="status" className="text-xs text-emerald-600">{keyNotice}</p>}
        </div>
      </Section>

      <Section title="Your MCP servers" description="Manage connected tools without duplicating their settings.">
        <Link to="/connections" className="text-[13px] font-medium text-primary hover:underline">
          Manage MCP servers in Connections
        </Link>
      </Section>

      <Section title="Plan" description="Plan and billing controls are a foundation only; no payment is collected.">
        <div className="max-w-xl rounded-xl border border-border/70 bg-card/60 p-4">
          <p className="text-sm font-semibold capitalize">{plan.plan || "Free"} plan</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {plan.plan === "pro"
              ? "Pro is intended to use Biz's configured provider without ads. The plan flag is a placeholder; billing is not enabled yet."
              : "Free uses the configured Biz provider when no personal API key is saved. Chat may show a quiet placeholder promotion."}
          </p>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {plan.hasOwnKey ? "A personal API key is active for AI requests." : "No personal API key is active."}
          </p>
        </div>
      </Section>

      <Section title="Memory" description="Review and manage the private facts and preferences Biz remembers.">
        <Link to="/memory" className="text-[13px] font-medium text-primary hover:underline">
          Manage saved memories
        </Link>
      </Section>

      <Section title="Security" description="Add a time-based authenticator for sign-in verification.">
        <Link to="/mfa" className="text-[13px] font-medium text-primary hover:underline">
          Manage two-factor authentication
        </Link>
      </Section>

      <Section title="Account" description="Sign out of Biz on this device.">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border/70 px-4 py-3.5">
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-medium text-foreground">
              {user?.full_name || "Your account"}
            </p>
            <p className="truncate text-[12.5px] text-muted-foreground">{user?.email || ""}</p>
          </div>
          <button
            type="button"
            onClick={() => api.auth.signOut().then(() => window.location.assign("/login"))}
            className="flex items-center gap-2 rounded-xl border border-border/80 px-3.5 py-2 text-[13px] text-foreground/90 transition-colors hover:bg-accent"
          >
            <LogOut className="h-4 w-4" strokeWidth={1.8} />
            Sign out
          </button>
        </div>
      </Section>
    </PageContainer>
  );
}