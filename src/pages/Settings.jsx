import React, { useEffect, useState } from "react";
import { Check, LogOut, Loader2, Monitor, Moon, Sun } from "lucide-react";
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