import React, { createContext, useState, useContext, useEffect, useCallback } from 'react'
import { api } from '@/api/client'
import { isUiPreview } from '@/lib/ui-preview'

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const uiPreview = isUiPreview();
  const [user, setUser] = useState(uiPreview ? { full_name: "UI Preview", email: "Local preview" } : null);
  const [isAuthenticated, setIsAuthenticated] = useState(uiPreview);
  const [isLoadingAuth, setIsLoadingAuth] = useState(!uiPreview);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(uiPreview);

  const checkUserAuth = useCallback(async () => {
    setIsLoadingAuth(true)
    try {
      const currentUser = await api.auth.me()
      setUser(currentUser)
      setIsAuthenticated(true)
      setAuthError(null)
    } catch (error) {
      setUser(null)
      setIsAuthenticated(false)
      setAuthError(error.status === 401 ? null : { type: 'unknown', message: error.message })
    } finally {
      setIsLoadingAuth(false)
      setAuthChecked(true)
    }
  }, [])

  const checkAppState = useCallback(async () => {
    try {
      setAuthError(null)
      await checkUserAuth()
    } catch (error) {
      setAuthError({ type: 'unknown', message: error.message || 'Unable to load your account.' })
      setIsLoadingAuth(false)
    }
  }, [checkUserAuth])

  useEffect(() => {
    if (uiPreview) return;
    checkAppState();
  }, [checkAppState, uiPreview]);

  const logout = async (shouldRedirect = true) => {
    await api.auth.signOut()
    setUser(null)
    setIsAuthenticated(false)
    setAuthChecked(true)
    if (shouldRedirect) window.location.assign('/login')
  }

  const navigateToLogin = () => {
    const returnTo = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`)
  }

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      authError,
      authChecked,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
