import React from "react"
import { Link } from "react-router-dom"
import { BrandMark } from "@/components/Brand"

/**
 * @param {{
 *   icon?: import("lucide-react").LucideIcon,
 *   title: string,
 *   subtitle?: string,
 *   footer?: React.ReactNode,
 *   children: React.ReactNode
 * }} props
 */
export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mx-auto mb-8 flex w-fit items-center gap-2 text-foreground" aria-label="AlphaTekx home">
          <BrandMark className="h-7 w-7" />
          <span className="text-sm font-medium tracking-tight">AlphaTekx</span>
        </Link>
        <section className="rounded-2xl border border-border/80 bg-card p-6 shadow-sm sm:p-8">
          <div className="mb-6 text-center">
            {Icon && (
              <span className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
            )}
            <h1 className="text-xl font-medium text-foreground">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          {children}
          {footer && <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>}
        </section>
      </div>
    </main>
  )
}
