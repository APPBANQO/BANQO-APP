// BANQO Perú · configuración Supabase
// Puedes reemplazar estos valores directamente y subir el archivo a GitHub Pages.
// La anon key está diseñada para estar en el frontend; la seguridad real depende de RLS.
export const DEFAULT_SUPABASE_URL = 'https://jfwcvdnpkthebpvhdvqq.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_8uZltcl2hf7sd54W19_Pyg_hZIyEWxw';

export const APP_CONFIG = {
  name: 'BANQO',
  version: '1.6.1-session-highlights-import-hotfix',
  defaultExam: 'RESIDENTADO',
  freeDailyQuestions: 15,
  exams: [
    { value: 'RESIDENTADO', label: 'Residentado Médico Perú' },
    { value: 'ENAM', label: 'ENAM' },
    { value: 'ESSALUD', label: 'EsSalud' },
    { value: 'OTRO', label: 'Otro' }
  ]
};
