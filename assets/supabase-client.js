import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } from './config.js';

const KEY = 'banqo_supabase_config_v1';
let client = null;

export function getStoredConfig(){
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export function saveStoredConfig(url, anonKey){
  localStorage.setItem(KEY, JSON.stringify({ url: url.trim(), anonKey: anonKey.trim() }));
  client = null;
}

export function clearStoredConfig(){
  localStorage.removeItem(KEY);
  client = null;
}

export function getConfig(){
  const stored = getStoredConfig();
  return {
    url: stored.url || DEFAULT_SUPABASE_URL,
    anonKey: stored.anonKey || DEFAULT_SUPABASE_ANON_KEY
  };
}

export function isConfigured(){
  const c = getConfig();
  return Boolean(c.url && c.anonKey);
}

export function db(){
  if (client) return client;
  const { url, anonKey } = getConfig();
  if (!url || !anonKey) return null;
  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return client;
}
