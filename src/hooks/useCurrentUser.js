import { useEffect, useState } from "react"
import { api } from "@/api/client"

export default function useCurrentUser() {
  const [user, setUser] = useState(null)

  useEffect(() => {
    let active = true
    api.auth.me().then((currentUser) => {
      if (active) setUser(currentUser)
    }).catch(() => {
      if (active) setUser(null)
    })
    return () => { active = false }
  }, [])

  return user
}
