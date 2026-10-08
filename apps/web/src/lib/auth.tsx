'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LoginInput, PermissionCode, SessionUser } from '@bme/shared';
import { api, ApiError } from './api';
import { SIGNED_OUT_EVENT } from './nav';

type AuthState = {
  user: SessionUser | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  can: (code: PermissionCode) => boolean;
  sessionExpired: () => boolean;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const expiredRef = useRef(false); // true once a signed-in person lost the session (so the login page can say why)

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
      expiredRef.current = true;
      setUser(null);
    };
    window.addEventListener(SIGNED_OUT_EVENT, gone);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, gone);
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    expiredRef.current = false;
    setUser(await api<SessionUser>('/auth/login', { body: input }));
  }, []);

  const logout = useCallback(async () => {
    expiredRef.current = false;
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, logout, can: (code) => !!user?.permissions.includes(code), sessionExpired: () => expiredRef.current }),
    [user, loading, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
