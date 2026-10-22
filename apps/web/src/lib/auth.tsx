'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LoginInput, PermissionCode, SessionUser } from '@bme/shared';
import { api, ApiError, clearFetchCache } from './api';
import { SIGNED_OUT_EVENT, type SignedOutReason } from './nav';

type AuthState = {
  user: SessionUser | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  logout: (reason?: 'idle') => Promise<void>;
  can: (code: PermissionCode) => boolean;
  signedOutReason: () => SignedOutReason;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const expiredRef = useRef<SignedOutReason>(null); // why a signed-in person lost the session (so the login page can say)
  const userRef = useRef<SessionUser | null>(null);
  userRef.current = user;

  useEffect(() => {
    api<SessionUser>('/auth/me')
      .then(setUser)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setLoading(false));
  }, []);

  // Another call found the session gone: drop the user, and the shell sends them to sign in.
  useEffect(() => {
    const gone = () => {
      clearFetchCache();
      // Only someone who was signed in can have lost a session; a page that asked before the first
      // "who am I" answer is not news (the shell sends a signed-out visitor to sign in anyway).
      if (!userRef.current) return;
      expiredRef.current = 'expired';
      setUser(null);
    };
    window.addEventListener(SIGNED_OUT_EVENT, gone);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, gone);
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    expiredRef.current = null;
    clearFetchCache();
    setUser(await api<SessionUser>('/auth/login', { body: input }));
  }, []);

  // `idle`: signed out for being left unused (lib/idle.ts), which the login page says.
  const logout = useCallback(async (reason?: 'idle') => {
    expiredRef.current = reason ?? null;
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    clearFetchCache();
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, logout, can: (code) => !!user?.permissions.includes(code), signedOutReason: () => expiredRef.current }),
    [user, loading, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
