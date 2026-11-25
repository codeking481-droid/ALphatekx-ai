import React from "react";

export default function Section({ title, description, children }) {
  return (
    <section className="border-t border-border/70 py-8 first:border-t-0 first:pt-0">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
        {title}
      </h2>
      {description && (
        <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}