import React, { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { api } from "@/api/client"
import AuthLayout from "@/components/AuthLayout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Lock, ShieldCheck, Loader2 } from "lucide-react"

export default function Mfa() {
  const [params] = useSearchParams()
  const isChallenge = params.get("twoFactor") === "1"
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [setup, setSetup] = useState(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setError("")
    setBusy(true)
    try {
      if (isChallenge) {
        await api.auth.verifyTotp(code)
        window.location.assign("/")
      } else {
        setSetup(await api.auth.enableTotp(password))
      }
    } catch (requestError) {
      setError(requestError.message || "Two-factor authentication could not be completed.")
    } finally {
      setBusy(false)
    }
  }

  const verifySetup = async (event) => {
    event.preventDefault()
    setError("")
    setBusy(true)
    try {
      await api.auth.verifyTotp(code)
      setSetup(null)
      setCode("")
      setError("Authenticator verification completed.")
    } catch (requestError) {
      setError(requestError.message || "The authenticator code could not be verified.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      icon={ShieldCheck}
      title={isChallenge ? "Two-factor verification" : "Set up an authenticator"}
      subtitle={isChallenge ? "Enter the code from your authenticator app." : "Protect your account with a time-based authenticator code."}
      footer={<Link to="/" className="text-primary font-medium hover:underline">Back to AlphaTekx</Link>}
    >
      {error && <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}
      {setup?.totpURI ? (
        <form onSubmit={verifySetup} className="space-y-4">
          <p className="break-all rounded-lg border border-border p-3 text-xs text-muted-foreground">
            Add this setup link to your authenticator app: {setup.totpURI}
          </p>
          <Label htmlFor="totp-code">Authenticator code</Label>
          <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required />
          <Button className="w-full" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify and enable"}</Button>
        </form>
      ) : isChallenge ? (
        <form onSubmit={submit} className="space-y-4">
          <Label htmlFor="totp-code">Authenticator code</Label>
          <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required />
          <Button className="w-full" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}</Button>
        </form>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Label htmlFor="password">Confirm your password</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input id="password" type="password" autoComplete="current-password" className="pl-10" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </div>
          <Button className="w-full" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Set up two-factor authentication"}</Button>
        </form>
      )}
    </AuthLayout>
  )
}
