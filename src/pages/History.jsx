import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, MessageSquare, Plus, Search, Trash2, X } from "lucide-react";

import PageContainer from "@/components/layout/PageContainer";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { api } from "@/api/client";

function dayGroup(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff <= 7) return "Previous 7 days";
  return "Earlier";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Earlier"];

function timeLabel(dateString) {
  return new Date(dateString).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function History() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");

    api.conversations.list({ search: query })
      .then((page) => {
        if (!alive) return;
        setItems(page.items || []);
        setCursor(page.next_cursor || null);
      })
      .catch((requestError) => {
        if (alive) setError(requestError.message || "Conversation history couldn't be loaded.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [query]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await api.conversations.list({ search: query, cursor });
      setItems((prev) => [...prev, ...(page.items || [])]);
      setCursor(page.next_cursor || null);
    } catch (requestError) {
      setError(requestError.message || "Older conversations couldn't be loaded.");
    } finally {
      setLoadingMore(false);
    }
  };

  const remove = async (id) => {
    setError("");
    try {
      await api.conversations.delete(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (requestError) {
      setError(requestError.message || "This conversation couldn't be deleted.");
    }
  };

  const grouped = items.reduce((acc, item) => {
    const label = dayGroup(item.updated_date || item.created_date);
    acc[label] = acc[label] || [];
    acc[label].push(item);
    return acc;
  }, {});

  return (
    <PageContainer
      title="History"
      description="Every conversation you've had with Biz, kept for you to return to."
      actions={
        <Link
          to="/"
          className="flex items-center gap-2 rounded-xl border border-border/80 px-3.5 py-2 text-[13px] font-medium text-foreground/90 transition-colors hover:bg-accent"
        >
          <Plus className="h-4 w-4" strokeWidth={1.8} />
          New chat
        </Link>
      }
    >
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.8}
        />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search conversations"
          className="h-10 w-full rounded-xl border border-border/80 bg-transparent pl-10 pr-10 text-[14px] text-foreground placeholder:text-muted-foreground/70 focus:border-border focus:outline-none focus:ring-2 focus:ring-ring/15"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        )}
      </div>

      <div className="mt-7">
        {error && <p className="mb-4 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive">{error}</p>}
        {loading ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.8} />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-border/70 px-6 py-14 text-center">
            <MessageSquare
              className="mx-auto h-5 w-5 text-muted-foreground/70"
              strokeWidth={1.6}
            />
            <p className="mt-4 text-[14px] text-foreground">
              {query ? "No conversations match that search." : "No conversations yet."}
            </p>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              {query
                ? "Try a different word or phrase."
                : "Start a chat and it will appear here."}
            </p>
          </div>
        ) : (
          <div className="space-y-7">
            {GROUP_ORDER.filter((label) => grouped[label]?.length).map((label) => (
              <div key={label}>
                <h3 className="px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                  {label}
                </h3>
                <div className="mt-2 space-y-0.5">
                  {grouped[label].map((item) => (
                    <div key={item.id} className="group relative">
                      <Link
                        to={`/c/${item.id}`}
                        className="flex items-start gap-3 rounded-xl py-2.5 pl-10 pr-12 transition-colors hover:bg-accent/70"
                      >
                        <MessageSquare
                          className="absolute left-3 top-3 h-4 w-4 text-muted-foreground/80"
                          strokeWidth={1.6}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-4">
                            <span className="truncate text-[14px] font-medium text-foreground">
                              {item.title}
                            </span>
                            <span className="shrink-0 text-[11.5px] text-muted-foreground/80">
                              {timeLabel(item.updated_date || item.created_date)}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                            {item.last_message || `${item.message_count || 0} messages`}
                          </span>
                        </span>
                      </Link>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Delete ${item.title}`}
                            className="absolute right-2 top-2.5 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-background hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="border-border/80 bg-card">
                          <AlertDialogHeader>
                            <AlertDialogTitle className="text-[17px] font-medium">
                              Delete this conversation?
                            </AlertDialogTitle>
                            <AlertDialogDescription className="text-[13.5px] text-muted-foreground">
                              “{item.title}” and all of its messages will be permanently removed.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel className="border-border/80">Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => remove(item.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {cursor && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="flex items-center gap-2 rounded-xl border border-border/80 px-4 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
                >
                  {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />}
                  Load older conversations
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </PageContainer>
  );
}