import React from "react";

/**
 * @param {{
 *   title: string,
 *   description?: string,
 *   actions?: React.ReactNode,
 *   children: React.ReactNode
 * }} props
 */
export default function PageContainer({ title, description, actions, children }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-5 pb-20 pt-10 sm:px-8 sm:pt-14">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-[30px] leading-[1.12] text-foreground sm:text-[34px]">
              {title}
            </h1>
            {description && (
              <p className="mt-2 max-w-lg text-[13.5px] leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions}
        </div>

        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}