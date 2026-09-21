import { APP_CONFIG } from './config.js';
import { db, connectDb, isConfigured, saveStoredConfig, clearStoredConfig, getConfig } from './supabase-client.js';
import { parseFile, validateQuestions, parseAnswerKeyPdf, mergeAnswerKey, sha256 } from './importers.js';

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const footer = document.getElementById('footer');
const contentToolbar = document.getElementById('contentToolbar');
const modalRoot = document.getElementById('modalRoot');
const toast = document.getElementById('toast');
const ACTIVE_KEY = 'banqo_active_session_v1';
const THEME_KEY = 'banqo_theme_v1';

const state = {
  user: null,
  profile: null,
  route: 'home',
  adminTab: 'questions',
  active: null,
  lastResult: null,
  importPreview: null,
  importValidation: null,
  currentImportFile: null,
  currentAnswerFile: null,
  answerKeyStats: null,
  importMeta: null,
  aiGeneration: { attempted:false, generated:0, skipped:0, error:null },
  deviceBlocked: false,
  pendingAttempts: [],
  pendingStates: [],
  busy: false
};

const esc = (v='') => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = d => d ? new Date(d).toLocaleString('es-PE',{dateStyle:'short',timeStyle:'short'}) : '—';
const pct = (a,b) => b ? Math.round((a/b)*100) : 0;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const shuffle = arr => {const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const chunk = (arr,n) => Array.from({length:Math.ceil(arr.length/n)},(_,i)=>arr.slice(i*n,(i+1)*n));

function notify(message, ms=2600){
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(notify.t); notify.t=setTimeout(()=>toast.classList.remove('show'),ms);
}
function humanError(e){
  const msg=String(e?.message||e||''),code=e?.code||'';
  if(/FREE_LIMIT_REACHED/i.test(msg))return 'Alcanzaste tu límite diario del plan gratuito. La respuesta no se registró.';
  if(/FREE_SIMULATION_LIMIT/i.test(msg))return 'Tu plan gratuito no tiene cupo suficiente para este simulacro.';
  if(/SIMULATION_NOT_READY/i.test(msg))return 'Este simulacro aún tiene preguntas pendientes de publicación. Avisa al administrador.';
  if(/NO_QUESTIONS/i.test(msg))return 'No hay preguntas publicadas con esos filtros.';
  if(/Failed to fetch|NetworkError|Load failed/i.test(msg))return navigator.onLine?'No pudimos conectar con el servidor. Reintenta en unos segundos.':'No tienes conexión. Conservaremos el estado local para reintentar.';
  if(/Invalid login credentials/i.test(msg))return 'Correo o contraseña incorrectos.';
  if(/Email not confirmed/i.test(msg))return 'Debes confirmar tu correo. Revisa también spam.';
  if(/User already registered/i.test(msg))return 'Ese correo ya tiene una cuenta. Inicia sesión o recupera tu contraseña.';
  if(/at least \d+ characters|Password should/i.test(msg))return 'La contraseña no cumple la longitud mínima.';
  if(/JWT expired|token is expired/i.test(msg))return 'Tu sesión expiró. Vuelve a iniciar sesión.';
  if(code==='42501'||/row-level security/i.test(msg))return 'No tienes permiso para esta acción con tu plan o rol actual.';
  if(code==='23505')return 'Ese registro ya existe.';
  if(code==='PGRST116')return 'No encontramos ese registro.';
  console.warn('[BANQO]',e);return 'Ocurrió un problema. Si continúa, indica qué estabas haciendo.';
}
function setBusy(v){state.busy=v;document.body.style.cursor=v?'progress':'';}
function activeForStorage(s){
  if(!s)return null;
  const {questions,...rest}=s;
  return {...rest,questionIds:s.questionIds||questions?.map(q=>q.id)||[],pendingAttempts:state.pendingAttempts,pendingStates:state.pendingStates};
}
function saveActive(){
  try{state.active?localStorage.setItem(ACTIVE_KEY,JSON.stringify(activeForStorage(state.active))):localStorage.removeItem(ACTIVE_KEY);}
  catch(e){console.warn('Sesión no persistida',e);notify('No se pudo guardar el progreso localmente. Evita cerrar la pestaña.',5000);}
}
function loadActive(){try{const s=JSON.parse(localStorage.getItem(ACTIVE_KEY)||'null');if(!s)return null;s.questionIds=s.questionIds||s.questions?.map(q=>q.id)||[];delete s.questions;s.answers=s.answers||{};s.revealed=s.revealed||{};s.marked=s.marked||{};s.discarded=s.discarded||{};state.pendingAttempts=s.pendingAttempts||[];state.pendingStates=s.pendingStates||[];delete s.pendingAttempts;delete s.pendingStates;return s;}catch{return null}}
function elapsed(){const s=state.active;if(!s)return 0;return (s.consumedSeconds||0)+(s.resumedAt?Math.floor((Date.now()-s.resumedAt)/1000):0)}
function pauseTimer(){const s=state.active;if(!s||s.finished)return;s.consumedSeconds=elapsed();s.resumedAt=null;clearInterval(renderQuiz.timer);saveActive();}
async function hydrateActive(){
  const s=state.active;if(!s||s.questions?.length)return;
  const {data,error}=await db().rpc('resume_study_session',{p_session:s.sessionId});if(error)throw error;
  s.questions=data?.questions||[];s.questionIds=s.questions.map(q=>q.id);s.answers={...(data?.answers||{}),...(s.answers||{})};
  if(data?.session?.status==='COMPLETADA'){s.finished=true;s.correct=Number(data.session.correct_count||0);s.incorrect=Number(data.session.incorrect_count||0);s.blank=Number(data.session.blank_count||0);s.elapsedSeconds=Number(data.session.elapsed_seconds||0);s.resumedAt=null;}
  for(const [id,v] of Object.entries(data?.question_state||{})){s.marked[id]=Boolean(v.marked);s.discarded[id]=v.discarded||[];}
  saveActive();
}
function applyTheme(){document.documentElement.dataset.theme=localStorage.getItem(THEME_KEY)||'light';}
function initials(){
  const name=state.profile?.full_name || state.user?.email || 'BQ';
  const parts=name.trim().split(/\s+/); return ((parts[0]?.[0]||'B')+(parts[1]?.[0]||parts[0]?.[1]||'Q')).toUpperCase();
}
function setShell(show){
  topbar?.classList.toggle('hide',!show);
  footer?.classList.toggle('hide',!show);
  contentToolbar?.classList.toggle('hide',!show);
}
function updateChrome(){
  const level=Math.max(1,Math.floor((state.profile?.xp||0)/250)+1);
  const xp=state.profile?.xp||0, progress=xp%250;
  const avatar=document.getElementById('avatarBtn'); if(avatar) avatar.textContent=initials();
  const streak=document.getElementById('streakCount'); if(streak) streak.textContent=state.profile?.streak||0;
  const admin=document.getElementById('adminNav'); if(admin) admin.classList.toggle('hide',!['admin','moderator'].includes(state.profile?.role));
  const name=document.getElementById('sidebarName'); if(name) name.textContent='Qbito · '+(state.profile?.full_name?.split(/\s+/)[0]||'BANQO');
  const lvl=document.getElementById('sidebarLevel'); if(lvl) lvl.textContent=`Nivel ${level}`;
  const xpTxt=document.getElementById('sidebarXp'); if(xpTxt) xpTxt.textContent=`${progress}/250 XP`;
  const xpBar=document.getElementById('sidebarXpBar'); if(xpBar) xpBar.style.width=`${Math.min(100,(progress/250)*100)}%`;
  const plan=document.getElementById('planPill'); if(plan) plan.textContent=state.profile?.role==='admin'?'Admin':(state.profile?.plan||'Free');
  document.querySelectorAll('.sidebar-nav [data-go]').forEach(b=>b.classList.toggle('active',b.dataset.go===state.route));
}

async function init(){
  applyTheme();
  new MutationObserver(()=>activateModalAccessibility()).observe(modalRoot,{childList:true});
  const themeBtn=document.getElementById('themeBtn');if(themeBtn)themeBtn.onclick=()=>{localStorage.setItem(THEME_KEY,(document.documentElement.dataset.theme==='dark'?'light':'dark'));applyTheme()};
  const avatarBtn=document.getElementById('avatarBtn');if(avatarBtn)avatarBtn.onclick=()=>showAccountModal();
  const profileNavBtn=document.getElementById('profileNavBtn');if(profileNavBtn)profileNavBtn.onclick=()=>showAccountModal();
  const quickSignOut=document.getElementById('quickSignOut');if(quickSignOut)quickSignOut.onclick=async()=>{if(state.active&&!state.active.finished&&!confirm('Tienes una sesión guardada. ¿Cerrar sesión de todas formas?'))return;await db().auth.signOut();};
  const mobileMenuBtn=document.getElementById('mobileMenuBtn');if(mobileMenuBtn)mobileMenuBtn.onclick=()=>{topbar?.classList.toggle('mobile-open');document.getElementById('menuBackdrop')?.classList.toggle('show',topbar?.classList.contains('mobile-open'));};
  const menuBackdrop=document.getElementById('menuBackdrop');if(menuBackdrop)menuBackdrop.onclick=()=>closeMobileMenu();
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeMobileMenu();closeModal();}});
  const connectionBanner=()=>document.body.classList.toggle('offline',!navigator.onLine);
  window.addEventListener('offline',()=>{connectionBanner();notify('Sin conexión. Tus acciones se reintentarán al recuperarla.',6000)});
  window.addEventListener('online',async()=>{connectionBanner();notify('Conexión restablecida.');await flushPendingAttempts();});connectionBanner();
  if(!isConfigured()){setShell(false);renderSetup();return;}
  let supa;
  try{supa=await connectDb();if(!(await pingSupabase()))throw new Error('La configuración de Supabase no responde.');}catch(e){setShell(false);app.innerHTML=`<section class="auth-shell"><div class="card auth-card"><h2>No se pudo cargar la conexión</h2><p class="danger-text">${esc(humanError(e))}</p><div class="cta-row"><button id="retryConnect" class="btn btn-primary">Reintentar</button><button id="changeConfig" class="btn">Cambiar conexión</button></div></div></section>`;document.getElementById('retryConnect').onclick=()=>location.reload();document.getElementById('changeConfig').onclick=()=>renderSetup();return;}
  const {data:{session}}=await supa.auth.getSession();
  if(!session){setShell(false);renderAuth();}
  else await bootUser(session.user);
  supa.auth.onAuthStateChange(async (event, session)=>{
    if(event==='PASSWORD_RECOVERY'){setShell(false);renderPasswordReset();return;}
    if(session?.user && session.user.id!==state.user?.id) await bootUser(session.user);
    if(!session?.user){clearInterval(enforceDeviceLock.t);clearInterval(renderQuiz.timer);state.user=null;state.profile=null;state.active=null;state.deviceBlocked=false;setShell(false);renderAuth();}
  });
  window.addEventListener('beforeunload',e=>{if(state.active && !state.active.finished){pauseTimer();e.preventDefault();e.returnValue='';}});
  window.addEventListener('hashchange',async()=>{
    if(state.deviceBlocked)return;
    const r=location.hash.replace('#','')||'home';
    if(!['home','practice','simulations','stats','errors','admin','quiz','results'].includes(r)) return;
    if(r==='admin' && !['admin','moderator'].includes(state.profile?.role)){location.hash='home';return;}
    if(state.route==='quiz'&&r!=='quiz'&&state.active&&!state.active.finished){if(!confirm('Hay una sesión en curso. ¿Salir? El progreso queda guardado.')){history.pushState(null,'','#quiz');return;}pauseTimer();}
    state.route=r; await renderRoute();
  });
}

async function pingSupabase(){try{const {error}=await db().from('profiles').select('id',{count:'exact',head:true}).limit(1);return !error||['42501','PGRST301','PGRST116'].includes(error.code);}catch{return false;}}

function closeMobileMenu(){topbar?.classList.remove('mobile-open');document.getElementById('menuBackdrop')?.classList.remove('show');}

async function bootUser(user){
  clearInterval(enforceDeviceLock.t);state.deviceBlocked=false;
  state.user=user;
  const supa=db();
  let {data:profile,error}=await supa.from('profiles').select('*').eq('id',user.id).maybeSingle();
  if(!profile&&!error){
    const full=user.user_metadata?.full_name||'';
    const ins=await supa.from('profiles').insert({id:user.id,full_name:full}).select().maybeSingle();
    if(ins.error&&ins.error.code!=='23505')console.warn(ins.error);
    const retry=await supa.from('profiles').select('*').eq('id',user.id).maybeSingle();profile=retry.data;
  }
  if(!profile){setShell(false);app.innerHTML=`<section class="auth-shell"><div class="card auth-card"><h2>No pudimos cargar tu perfil</h2><p class="muted">Revisa tu conexión y vuelve a entrar.</p><button class="btn btn-primary" onclick="location.reload()">Reintentar</button></div></section>`;return;}
  state.profile=profile;
  if(!['admin','moderator'].includes(profile?.role)){
    const ok=await enforceDeviceLock();
    if(!ok)return;
  }
  state.active=loadActive();
  if(state.active){try{await hydrateActive();}catch(e){console.warn('No se pudo rehidratar la sesión',e);}}
  setShell(true);updateChrome();
  const hash=location.hash.replace('#','');
  state.route=['home','practice','simulations','stats','errors','admin','quiz','results'].includes(hash)?hash:'home';
  if(state.route==='admin' && !['admin','moderator'].includes(profile?.role)) state.route='home';
  await renderRoute();
}


function getDeviceId(){
  let id=localStorage.getItem('banqo_device_id_v1');
  if(!id){id=(crypto.randomUUID?crypto.randomUUID():`dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);localStorage.setItem('banqo_device_id_v1',id);}
  return id;
}
async function enforceDeviceLock(){
  const id=getDeviceId();
  const name=`${navigator.platform||'Dispositivo'} · ${navigator.userAgent.includes('Mobile')?'móvil':'navegador'}`;
  const {data,error}=await db().rpc('claim_device',{p_device_id:id,p_device_name:name});
  if(error){console.warn('Device lock no disponible:',error.message);return true;}
  if(data?.ok!==false){
    state.deviceBlocked=false;
    clearInterval(enforceDeviceLock.t);
    enforceDeviceLock.t=setInterval(()=>db().rpc('claim_device',{p_device_id:id,p_device_name:name}),5*60*1000);
    return true;
  }
  state.deviceBlocked=true;
  setShell(false);
  app.innerHTML=`<section class="auth-shell"><div class="card auth-card"><div class="auth-logo"><span class="brand-mark">B</span><div><div class="kicker">SEGURIDAD DE CUENTA</div><h2>Cuenta activa en otro dispositivo</h2></div></div><p class="muted">BANQO está configurado para una sesión de dispositivo por cuenta. El otro dispositivo figura como <strong>${esc(data.device_name||'otro dispositivo')}</strong>.</p><p class="small muted">Última actividad: ${fmt(data.last_seen_at)}</p><button id="deviceLogout" class="btn btn-primary">Cerrar sesión</button></div></section>`;
  document.getElementById('deviceLogout').onclick=()=>db().auth.signOut();
  return false;
}

function renderSetup(){
  const c=getConfig();
  app.innerHTML=`<section class="auth-shell"><div class="card auth-card">
    <div class="auth-logo"><span class="brand-mark">B</span><div><div class="kicker">BANQO PERÚ</div><h2>Conectar Supabase</h2></div></div>
    <p class="muted">Esta versión funciona con GitHub Pages + Supabase. Primero crea un proyecto gratuito, ejecuta <span class="code">supabase/schema.sql</span> y pega aquí la URL y la anon key.</p>
    <div class="stack">
      <div class="field"><label>Project URL</label><input id="setupUrl" placeholder="https://xxxxx.supabase.co" value="${esc(c.url||'')}" /></div>
      <div class="field"><label>Anon / publishable key</label><textarea id="setupKey" class="textarea-md" placeholder="eyJ...">${esc(c.anonKey||'')}</textarea></div>
      <button id="saveSetup" class="btn btn-primary">Guardar y conectar</button>
    </div>
    <div class="notice" style="margin-top:18px"><strong>Importante:</strong> no coloques la <span class="code">service_role</span> key en el navegador. La app usa únicamente la anon/publishable key y las políticas RLS del esquema.</div>
  </div></section>`;
  document.getElementById('saveSetup').onclick=()=>{
    const url=document.getElementById('setupUrl').value.trim(),key=document.getElementById('setupKey').value.trim();
    if(!url||!key){notify('Completa URL y anon key');return;} saveStoredConfig(url,key);location.reload();
  };
}

function renderAuth(){
  app.innerHTML=`<section class="auth-shell"><div class="auth-split auth-card">
    <div class="auth-panel">
      <div class="auth-logo"><span class="brand-mark">✚</span><div><div class="kicker">BANQO</div><strong>Preparación médica</strong></div></div>
      <div class="auth-tabs"><button class="tab-btn active" data-auth="login">Iniciar sesión</button><button class="tab-btn" data-auth="register">Crear cuenta</button></div>
      <div id="authBody"></div><button id="changeConfig" class="btn btn-soft" style="margin-top:14px;width:100%">Cambiar conexión de Supabase</button>
    </div>
    <div class="auth-side"><div class="auth-side-avatar">👩‍⚕️</div><h3>Una cuenta, una sesión activa</h3><p>Tu progreso queda guardado y sincronizado. BANQO mantiene una sola sesión por cuenta para proteger tu acceso y tus datos de estudio.</p></div>
  </div></section>`;
  const show=(mode)=>{
    document.querySelectorAll('[data-auth]').forEach(b=>b.classList.toggle('active',b.dataset.auth===mode));
    const body=document.getElementById('authBody'); if(!body)return;
    body.innerHTML=mode==='login'?`
      <div class="stack"><div class="field"><label>Correo</label><input id="authEmail" type="email" autocomplete="email" /></div><div class="field"><label>Contraseña</label><input id="authPass" type="password" autocomplete="current-password" /></div><button id="authSubmit" class="btn btn-primary">Iniciar sesión</button><button id="forgotPassword" class="btn btn-soft" type="button">Olvidé mi contraseña</button></div>`:`
      <div class="stack"><div class="auth-register-grid"><div class="field"><label>Nombres</label><input id="authFirst" autocomplete="given-name" /></div><div class="field"><label>Apellidos</label><input id="authLast" autocomplete="family-name" /></div></div><div class="field"><label>Correo</label><input id="authEmail" type="email" autocomplete="email" /></div><div class="field"><label>Contraseña</label><input id="authPass" type="password" autocomplete="new-password" placeholder="Mín. 8 caracteres, 1 mayúscula y 1 número" /></div><div class="field"><label>¿Para qué te estás preparando?</label><select id="authTarget"><option value="RESIDENTADO">Residentado Médico</option><option value="ENAM">ENAM</option><option value="ESSALUD">EsSalud</option><option value="TODOS">Todos</option></select></div><button id="authSubmit" class="btn btn-primary">Crear cuenta</button><p class="muted small" style="margin:0">La contraseña debe tener al menos 8 caracteres, una mayúscula y un número.</p></div>`;
    const submit=document.getElementById('authSubmit');if(!submit)return;
    submit.onclick=async()=>{
      const email=document.getElementById('authEmail')?.value.trim(),pass=document.getElementById('authPass')?.value||'';
      if(!email||!pass){notify('Completa correo y contraseña');return;}
      setBusy(true);
      try{
        if(mode==='login'){
          const {error}=await db().auth.signInWithPassword({email,password:pass}); if(error) throw error;
        }else{
          if(pass.length<8 || !/[A-Z]/.test(pass) || !/\d/.test(pass)){notify('La contraseña debe tener 8+ caracteres, 1 mayúscula y 1 número');return;}
          const first=document.getElementById('authFirst')?.value.trim()||'',last=document.getElementById('authLast')?.value.trim()||'';
          const full_name=`${first} ${last}`.trim(),target_exam=document.getElementById('authTarget')?.value||'RESIDENTADO';
          if(!first||!last){notify('Completa nombres y apellidos');return;}
          const {data,error}=await db().auth.signUp({email,password:pass,options:{data:{full_name,target_exam}}}); if(error) throw error;
          if(!data.session) notify('Cuenta creada. Revisa tu correo para confirmar el registro.',5000);
        }
      }catch(e){notify(humanError(e),5000)} finally{setBusy(false)}
    };
    const forgot=document.getElementById('forgotPassword');if(forgot)forgot.onclick=async()=>{const email=document.getElementById('authEmail')?.value.trim();if(!email){notify('Escribe primero tu correo');return;}const {error}=await db().auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});notify(error?humanError(error):'Te enviamos un enlace para crear una nueva contraseña.',6000);};
  };
  document.querySelectorAll('[data-auth]').forEach(b=>b.onclick=()=>show(b.dataset.auth));show('login');
  const changeConfig=document.getElementById('changeConfig');if(changeConfig)changeConfig.onclick=()=>{if(confirm('¿Cambiar la conexión guardada?'))renderSetup();};
}

function renderPasswordReset(){
  app.innerHTML=`<section class="auth-shell"><div class="card auth-card"><h2>Nueva contraseña</h2><p class="muted">Usa al menos 8 caracteres, una mayúscula y un número.</p><div class="field"><label>Nueva contraseña</label><input id="newPassword" type="password" autocomplete="new-password"></div><button id="savePassword" class="btn btn-primary" style="margin-top:14px">Guardar contraseña</button></div></section>`;
  document.getElementById('savePassword').onclick=async()=>{const password=document.getElementById('newPassword').value;if(password.length<8||!/[A-Z]/.test(password)||!/\d/.test(password)){notify('La contraseña no cumple los requisitos.');return;}const {error}=await db().auth.updateUser({password});if(error)notify(humanError(error),5000);else{notify('Contraseña actualizada.');location.hash='home';location.reload();}};
}

async function go(route, force=false){
  closeMobileMenu();
  if(!force && state.active && !state.active.finished && state.route==='quiz' && route!=='quiz'){
    if(!confirm('Hay una sesión en curso. ¿Salir? El progreso queda guardado para continuar después.')) return;
  }
  if(state.route==='quiz'&&route!=='quiz')pauseTimer();
  state.route=route;
  const nextHash = `#${route}`;
  if(location.hash !== nextHash){
    location.hash=route; // hashchange hará el render una sola vez
  }else{
    await renderRoute();
  }
  window.scrollTo(0,0);
}

async function renderRoute(){
  if(!state.user||state.deviceBlocked) return;
  if(state.route==='quiz'&&state.active&&!state.active.questions?.length)await hydrateActive();
  updateChrome();
  try{
    if(state.route==='home') await renderHome();
    else if(state.route==='practice') await renderPractice();
    else if(state.route==='simulations') await renderSimulations();
    else if(state.route==='stats') await renderStats();
    else if(state.route==='errors') await renderErrors();
    else if(state.route==='admin') await renderAdmin();
    else if(state.route==='quiz') renderQuiz();
    else if(state.route==='results') renderResults();
  }catch(e){console.error(e);app.innerHTML=`<section class="page"><div class="card"><h2>Ocurrió un error</h2><p class="danger-text">${esc(humanError(e))}</p><button class="btn" data-go="home">Volver</button></div></section>`;bindGo();}
}
function bindGo(){ /* navegación delegada por el listener global; evita dobles llamadas */ }

async function renderHome(){
  const supa=db();
  const [q,progress,sim]=await Promise.all([
    supa.from('questions').select('id',{count:'exact',head:true}).eq('status','PUBLICADA'),
    supa.rpc('user_progress_summary'),
    supa.from('simulation_sets').select('id',{count:'exact',head:true}).eq('status','PUBLICADO')
  ]);
  const stats=progress.data||{total:0,correct:0,sessions:0};
  const first=(state.profile?.full_name||'').split(/\s+/).filter(Boolean)[0]||'Doctor';
  const resume=state.active && !state.active.finished ? `<div class="notice success" style="margin-top:14px"><div class="space-between"><div><strong>Sesión guardada</strong><div class="small muted">Pregunta ${(state.active.index||0)+1} de ${state.active.questions?.length||state.active.questionIds?.length||0}</div></div><button id="resumeBtn" class="btn btn-primary">Continuar</button></div></div>`:'';
  app.innerHTML=`<section class="page">
    <div class="dashboard-head"><div><div class="kicker">BANQO · DISCIPLINA MÉDICA</div><h1>¡Hola, ${esc(first)}!</h1><p class="muted" style="margin:0">Un paso más cerca de tu plaza. Hoy toca avanzar con preguntas.</p></div><div class="dashboard-welcome"><div class="dashboard-avatar">👩‍⚕️</div></div></div>
    <div class="discipline-card card"><div><div class="kicker">RESUMEN</div><h2>Tu rendimiento</h2><div class="grid grid-3" style="margin-top:16px"><div class="stats-card"><span class="muted small">Preguntas hechas</span><strong>${stats.total||0}</strong></div><div class="stats-card"><span class="muted small">Precisión</span><strong>${pct(stats.correct||0,stats.total||0)}%</strong></div><div class="stats-card"><span class="muted small">Sesiones</span><strong>${stats.sessions||0}</strong></div></div>${resume}</div><div class="discipline-score"><div class="kicker">BANQO · HOY</div><h3>Disciplina &gt; motivación</h3><p class="muted small">Cada sesión suma. Tienes ${q.count||0} preguntas publicadas y ${sim.count||0} simulacros disponibles.</p><button class="btn btn-primary" data-go="practice">Banquear ahora</button></div></div>
    <div class="section-head"><div><h2>Plan de estudio</h2><p class="muted">Accesos rápidos para continuar.</p></div></div>
    <div class="home-quick"><div class="card card-click" data-home-exam="RESIDENTADO"><div class="bank-icon">🧠</div><h3>Medicina</h3><p class="muted small">Banqueo por especialidad, tema y subtema.</p></div><div class="card card-click" data-home-go="simulations"><div class="bank-icon">📄</div><h3>Simulacros</h3><p class="muted small">Modo examen real o explicación después de cada pregunta.</p></div><div class="card card-click" data-home-go="errors"><div class="bank-icon">🔁</div><h3>Repaso de errores</h3><p class="muted small">Vuelve a resolver lo que más te cuesta.</p></div></div>
  </section>`;
  bindGo();
  document.querySelectorAll('[data-home-go]').forEach(c=>c.onclick=()=>go(c.dataset.homeGo));
  document.querySelectorAll('[data-home-exam]').forEach(c=>c.onclick=()=>{sessionStorage.setItem('banqo_pref_exam',c.dataset.homeExam||'');go('practice');});
  const r=document.getElementById('resumeBtn');if(r)r.onclick=()=>go('quiz',true);
}
async function getPracticeMetadata(){
  const {data,error}=await db().from('v_active_taxonomy').select('*');
  if(error) throw error; return data||[];
}
function optionsFor(values,placeholder='Todos'){
  const arr=[...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
  return `<option value="">${placeholder}</option>`+arr.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
}
async function renderPractice(){
  const md=await getPracticeMetadata();
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">BANQUEO</div><h2>Configura tu sesión</h2><p class="muted">Las preguntas se obtienen de Supabase y solo se muestran si están PUBLICADAS.</p></div></div>
    <div class="card"><div class="filters">
      <div class="field"><label>Examen</label><select id="pExam">${optionsFor(md.map(x=>x.exam_type),'Todos')}</select></div>
      <div class="field"><label>Banco</label><select id="pBank">${optionsFor(md.map(x=>x.bank_name),'Todos')}</select></div>
      <div class="field"><label>Especialidad</label><select id="pSpec">${optionsFor(md.map(x=>x.specialty),'Todas')}</select></div>
      <div class="field"><label>Tema</label><select id="pTopic">${optionsFor(md.map(x=>x.topic),'Todos')}</select></div>
      <div class="field"><label>Subtema</label><select id="pSubtopic">${optionsFor(md.map(x=>x.subtopic),'Todos')}</select></div>
      <div class="field"><label>Preguntas</label><select id="pCount"><option>5</option><option>10</option><option selected>15</option><option>20</option><option>30</option><option>50</option></select></div>
      <div class="field"><label>Corrección</label><select id="pMode"><option value="instant">Inmediata</option><option value="exam">Al final</option></select></div>
      <div class="field"><label>Orden</label><select id="pOrder"><option value="random">Aleatorio</option><option value="sequential">Secuencial</option></select></div>
    </div><div class="cta-row"><button id="startPractice" class="btn btn-primary">Comenzar banqueo</button><span id="availablePractice" class="tag">Calculando disponibilidad…</span><span class="tag">Plan ${esc(state.profile?.plan||'free')}</span><span id="dailyLimitTag" class="tag"></span></div></div>
    <div class="section-head"><div><h2>Funciones de estudio</h2></div></div><div class="grid grid-3"><div class="card"><h3>⭐ Marcar y favoritas</h3><p class="muted">Marca preguntas para revisar y guárdalas en tu colección.</p></div><div class="card"><h3>✂️ Descartar opciones</h3><p class="muted">Entrena el descarte sin perder la alternativa original.</p></div><div class="card"><h3>📝 Notas</h3><p class="muted">Guarda notas privadas por pregunta en Supabase.</p></div></div>
  </section>`;
  const prefExam=sessionStorage.getItem('banqo_pref_exam');
  if(prefExam){const sel=document.getElementById('pExam');if(sel && [...sel.options].some(o=>o.value===prefExam))sel.value=prefExam;sessionStorage.removeItem('banqo_pref_exam');}
  bindPracticeFilters(md);freeRemaining().then(n=>{const tag=document.getElementById('dailyLimitTag');if(tag)tag.textContent=Number.isFinite(n)?`Hoy quedan ${n}`:'Plan ilimitado';});
  const startPracticeBtn=document.getElementById('startPractice');if(startPracticeBtn)startPracticeBtn.onclick=startPractice;
}

function bindPracticeFilters(md){
  const ids=['pExam','pBank','pSpec','pTopic','pSubtopic'];
  const fields=['exam_type','bank_name','specialty','topic','subtopic'];
  const refresh=changed=>{
    const idx=ids.indexOf(changed);
    for(let target=Math.max(0,idx+1);target<ids.length;target++){
      const el=document.getElementById(ids[target]);if(!el)continue;const old=el.value;
      const filtered=md.filter(row=>fields.slice(0,target).every((f,i)=>!document.getElementById(ids[i])?.value||row[f]===document.getElementById(ids[i]).value));
      el.innerHTML=optionsFor(filtered.map(x=>x[fields[target]]),target===2?'Todas':'Todos');if([...el.options].some(o=>o.value===old))el.value=old;
    }
    const active=md.filter(row=>fields.every((f,i)=>!document.getElementById(ids[i])?.value||row[f]===document.getElementById(ids[i]).value));
    const available=active.reduce((n,x)=>n+Number(x.available||0),0);const tag=document.getElementById('availablePractice');if(tag)tag.textContent=`${available} disponibles`;
  };
  ids.forEach(id=>document.getElementById(id)?.addEventListener('change',()=>refresh(id)));refresh('');
}

async function freeRemaining(){
  const {data,error}=await db().rpc('free_questions_remaining');
  if(!error && Number(data)===-1) return Infinity;
  if(!error && Number.isFinite(Number(data))) return Number(data);
  if(state.profile?.role==='admin' || ['pro','admin'].includes(state.profile?.plan)) return Infinity;
  return APP_CONFIG.freeDailyQuestions;
}

async function startPractice(){
  setBusy(true);
  try{
    let count=Number(document.getElementById('pCount').value)||15;
    const remaining=await freeRemaining();
    if(remaining<=0){notify('Ya alcanzaste el límite gratuito de hoy.',4500);return;}
    if(Number.isFinite(remaining) && count>remaining){count=remaining;notify(`Hoy te quedan ${remaining} preguntas gratuitas.`);}
    const mode=document.getElementById('pMode').value;
    const filters={exam:document.getElementById('pExam').value,bank:document.getElementById('pBank').value,specialty:document.getElementById('pSpec').value,topic:document.getElementById('pTopic').value,subtopic:document.getElementById('pSubtopic').value};
    const {data,error}=await db().rpc('start_practice',{p_count:count,p_mode:mode,p_filters:filters,p_random:document.getElementById('pOrder').value==='random',p_question_ids:null});if(error)throw error;
    const questions=data?.questions||[];if(!questions.length)throw new Error('NO_QUESTIONS');
    state.active={sessionId:data.session_id,type:'PRACTICE',mode,questions,questionIds:questions.map(x=>x.id),answers:{},revealed:{},marked:{},discarded:{},index:0,consumedSeconds:0,resumedAt:Date.now(),finished:false};saveActive();
    await go('quiz',true);
  }catch(e){notify(humanError(e),5000)}finally{setBusy(false)}
}

async function renderSimulations(){
  const remaining=await freeRemaining();
  const {data,error}=await db().from('simulation_sets').select('*').eq('status','PUBLICADO').order('year',{ascending:false}).order('name');if(error)throw error;
  const sims=data||[];
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">SIMULACROS</div><h2>Elige un simulacro</h2><p class="muted">Antes de empezar podrás elegir cuándo ver las respuestas.</p></div></div>
    ${sims.length?`<div class="grid grid-3">${sims.map(s=>{const locked=Number.isFinite(remaining)&&remaining<(s.question_count||0);return `<div class="card ${locked?'':'card-click sim-card'}" ${locked?'':`data-sim="${s.id}"`}><div class="bank-icon">${locked?'🔒':'📄'}</div><div class="pill-row"><span class="tag">${esc(s.exam_type)}</span>${s.year?`<span class="tag">${s.year}</span>`:''}</div><h3 style="margin-top:11px">${esc(s.name)}</h3><p class="muted">${s.question_count||0} preguntas${s.duration_minutes?` · ${s.duration_minutes} min`:''}</p>${locked?`<div class="notice warning small">Tu plan dispone de ${remaining} preguntas hoy; este simulacro requiere ${s.question_count}.</div>`:'<button class="btn btn-primary" style="width:100%">Iniciar simulacro</button>'}</div>`}).join('')}</div>`:'<div class="card empty">Aún no hay simulacros publicados.</div>'}
  </section>`;
  document.querySelectorAll('.sim-card').forEach(c=>c.onclick=()=>prepareSimulation(c.dataset.sim));
}

async function prepareSimulation(id){
  setBusy(true);
  try{
    const [{data:sim,error:e1},{data:ready,error:e2}]=await Promise.all([db().from('simulation_sets').select('*').eq('id',id).single(),db().rpc('simulation_readiness',{p_sim:id})]);if(e1)throw e1;if(e2)throw e2;
    if(Number(ready?.published||0)<Number(sim.question_count||0)){notify(`Este simulacro registra ${sim.question_count||0} preguntas, pero sólo ${ready?.published||0} están publicadas.`,6000);return;}
    showSimulationModeModal(sim);
  }catch(e){notify(humanError(e),5000)}finally{setBusy(false)}
}

function showSimulationModeModal(sim){
  let selected='exam';
  modalRoot.innerHTML=`<div class="modal-backdrop"><div class="modal compact"><div style="text-align:center"><div class="auth-side-avatar" style="width:64px;height:64px;font-size:32px;background:#dcfaee;color:#123;margin-bottom:12px">👩‍⚕️</div><h2>¿Cuándo quieres ver las respuestas?</h2><p class="muted small">Primero selecciona una modalidad. El examen recién comenzará cuando pulses <strong>Confirmar e iniciar</strong>.</p></div><div class="mode-choice-grid"><button class="mode-choice" data-mode="instant"><span class="mode-icon">⚡</span><strong>Después de cada pregunta</strong><span class="muted small">Respuesta correcta, explicación y dato clave apenas confirmas tu respuesta.</span></button><button class="mode-choice selected" data-mode="exam"><span class="recommended">Recomendado</span><span class="mode-icon">🏁</span><strong>Al finalizar</strong><span class="muted small">Respondes todo primero y al final ves la revisión completa.</span></button></div><div class="modal-actions"><button id="cancelSimMode" class="btn">Cancelar</button><button id="confirmSimMode" class="btn btn-primary">Confirmar e iniciar</button></div></div></div>`;
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{selected=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('selected',x===b));});
  document.getElementById('cancelSimMode').onclick=closeModal;
  document.getElementById('confirmSimMode').onclick=()=>startSimulation(sim,selected);
}

async function startSimulation(sim,mode='exam'){
  setBusy(true);
  try{
    const {data,error}=await db().rpc('start_simulation',{p_sim:sim.id,p_mode:mode});if(error)throw error;
    const questions=data?.questions||[];
    state.active={sessionId:data.session_id,type:'SIMULATION',simulation:data.simulation||sim,mode,questions,questionIds:questions.map(x=>x.id),answers:{},revealed:{},marked:{},discarded:{},index:0,consumedSeconds:0,resumedAt:Date.now(),durationMinutes:sim.duration_minutes||null,finished:false};saveActive();closeModal();await go('quiz',true);
  }catch(e){notify(humanError(e),5000)}finally{setBusy(false)}
}

function currentQuestion(){return state.active?.questions?.[state.active.index||0]}
function timeText(sec){const m=Math.floor(sec/60),s=sec%60;return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
function resolveImage(url){if(!url)return '';if(/^https?:\/\//i.test(url))return url;return new URL(url,document.baseURI).href;}

function renderQuiz(){
  const s=state.active;if(!s||s.finished){go('home',true);return;}
  if(!s.resumedAt)s.resumedAt=Date.now();
  const q=currentQuestion();if(!q){go('home',true);return;}
  const selected=s.answers[q.id]||null,revealed=Boolean(s.revealed[q.id]);
  const discarded=new Set(s.discarded[q.id]||[]);
  const options=Object.entries(q.options||{}).map(([k,v])=>{
    const classes=['option'];if(selected===k)classes.push('selected');if(discarded.has(k))classes.push('discarded');if(revealed&&k===q.correct_answer)classes.push('correct');else if(revealed&&selected===k&&selected!==q.correct_answer)classes.push('wrong');
    return `<div class="${classes.join(' ')}" data-answer="${k}"><span class="option-letter">${k}</span><span>${esc(v)}</span><button class="discard-btn" data-discard="${k}" title="Descartar/recuperar opción">×</button></div>`;
  }).join('');
  const answered=Object.keys(s.answers).length;
  app.innerHTML=`<section class="page"><div class="quiz-shell"><div class="card quiz-card">
    <div class="quiz-meta"><div class="pill-row"><span class="tag">${esc(q.exam_type)}</span><span class="tag">${esc(q.bank_name)}</span><span class="tag">${esc(q.specialty)}</span></div><span class="tag">${s.index+1}/${s.questions.length}</span></div>
    <div class="source-chip">${esc(q.source_reference||q.external_id)}</div><p id="questionStem" class="question" data-question-id="${q.id}">${esc(q.stem)}</p>${q.image_url?`<img class="question-image" src="${esc(resolveImage(q.image_url))}" alt="Imagen de la pregunta" />`:''}
    <div class="options">${options}</div>
    <div class="quiz-tools"><button id="markBtn" class="btn btn-soft mark-btn ${s.marked[q.id]?'active':''}">⭐ ${s.marked[q.id]?'Marcada':'Marcar'}</button><button id="favBtn" class="btn btn-soft">♡ Favorita</button><button id="clearHighlights" class="btn btn-soft">🖍 Borrar resaltado</button><button id="reportBtn" class="btn btn-soft">⚑ Reportar</button></div>
    ${revealed?`<div class="explanation"><div class="explanation-title">✅ Respuesta correcta: ${esc(q.correct_answer||'—')}</div><div><strong>Explicación:</strong> ${q.explanation?esc(q.explanation):'<span class="muted">Esta pregunta todavía no tiene explicación.</span>'}</div>${q.galactic_tip?`<div class="key-fact"><strong>Dato clave:</strong> ${esc(q.galactic_tip)}</div>`:''}</div>`:''}
    <div class="quiz-actions"><button id="prevQ" class="btn" ${s.index===0?'disabled':''}>← Anterior</button><div class="inline">${s.index===s.questions.length-1?'<button id="finishQ" class="btn btn-primary">Finalizar</button>':'<button id="nextQ" class="btn btn-primary">Siguiente →</button>'}</div></div>
  </div><aside class="card quiz-side"><div class="space-between"><div><div class="kicker">PROGRESO</div><h3>${answered}/${s.questions.length}</h3></div><div id="timer" class="tag">${s.durationMinutes?`Restan ${timeText(Math.max(0,s.durationMinutes*60-elapsed()))}`:timeText(elapsed())}</div></div><div class="progress-line" style="margin:14px 0"><span style="width:${pct(answered,s.questions.length)}%"></span></div><details class="question-navigator" open><summary>Ir a la pregunta (${s.index+1}/${s.questions.length})</summary><div class="side-list">${s.questions.map((x,i)=>`<button class="qdot ${i===s.index?'current':''} ${s.answers[x.id]?'done':''} ${s.marked[x.id]?'warn':''}" data-qindex="${i}">${i+1}</button>`).join('')}</div></details><div class="divider"></div><div class="field"><label>Nota personal <span id="noteStatus" class="muted small"></span></label><textarea id="questionNote" class="textarea-md" placeholder="Escribe una nota privada..."></textarea><button id="saveNote" class="btn btn-soft" style="margin-top:8px">Guardar nota</button></div><div class="divider"></div>${s.limitReached?'<div class="notice warning small">Alcanzaste el límite diario. Las respuestas nuevas no se registrarán.</div>':''}<button id="leaveQuiz" class="btn btn-danger" style="width:100%;margin-top:10px">Salir de la sesión</button></aside></div></section>`;
  document.querySelectorAll('[data-answer]').forEach(o=>o.onclick=e=>{if(e.target.closest('[data-discard]'))return;answerQuestion(o.dataset.answer)});
  document.querySelectorAll('[data-discard]').forEach(b=>b.onclick=e=>{e.stopPropagation();toggleDiscard(b.dataset.discard)});
  document.querySelectorAll('[data-qindex]').forEach(b=>b.onclick=()=>{s.index=Number(b.dataset.qindex);saveActive();renderQuiz()});
  document.getElementById('prevQ').onclick=()=>{if(s.index>0){s.index--;saveActive();renderQuiz()}};
  const n=document.getElementById('nextQ');if(n)n.onclick=()=>{if(s.index<s.questions.length-1){s.index++;saveActive();renderQuiz()}};
  const f=document.getElementById('finishQ');if(f)f.onclick=finishStudy;
  document.getElementById('markBtn').onclick=async()=>{s.marked[q.id]=!s.marked[q.id];saveActive();await persistQuestionState(q.id);renderQuiz()};
  document.getElementById('favBtn').onclick=()=>toggleFavorite(q.id);
  document.getElementById('reportBtn').onclick=()=>showReportModal(q);
  document.getElementById('saveNote').onclick=()=>saveNote(q.id,document.getElementById('questionNote').value);
  const noteEl=document.getElementById('questionNote');noteEl.oninput=()=>{const value=noteEl.value,status=document.getElementById('noteStatus');if(status)status.textContent='Guardando…';saveNote.timers=saveNote.timers||new Map();clearTimeout(saveNote.timers.get(q.id));saveNote.timers.set(q.id,setTimeout(()=>saveNote(q.id,value,true),800));};
  document.getElementById('clearHighlights').onclick=()=>clearHighlights(q.id);
  document.getElementById('leaveQuiz').onclick=()=>go('home');
  loadNote(q.id);
  loadHighlights(q.id);document.getElementById('questionStem').addEventListener('mouseup',()=>saveSelectedHighlight(q.id));
  document.querySelectorAll('.question-image').forEach(img=>img.onerror=()=>{const d=document.createElement('div');d.className='notice warning';d.textContent='No se pudo cargar la imagen de esta pregunta. Repórtala con ⚑.';img.replaceWith(d);});
  s.shownAt=Date.now();saveActive();
  clearInterval(renderQuiz.timer);renderQuiz.timer=setInterval(()=>{const used=elapsed(),t=document.getElementById('timer');if(t)t.textContent=s.durationMinutes?`Restan ${timeText(Math.max(0,s.durationMinutes*60-used))}`:timeText(used);if(s.durationMinutes){const left=s.durationMinutes*60-used;if(left<=300&&!s.fiveMinuteWarning){s.fiveMinuteWarning=true;notify('Quedan 5 minutos para finalizar.',5000);}if(left<=0){clearInterval(renderQuiz.timer);finishStudy(true);}}},1000);
  window.scrollTo({top:0,behavior:'auto'});
}

async function toggleDiscard(letter){
  const s=state.active,q=currentQuestion();const arr=new Set(s.discarded[q.id]||[]);arr.has(letter)?arr.delete(letter):arr.add(letter);s.discarded[q.id]=[...arr];saveActive();await persistQuestionState(q.id);renderQuiz();
}
async function answerQuestion(letter){
  const s=state.active,q=currentQuestion();if(s.revealed[q.id]||s.limitReached)return;
  const payload={p_session:s.sessionId,p_question:q.id,p_letter:letter,p_marked:Boolean(s.marked[q.id]),p_discarded:s.discarded[q.id]||[],p_response_ms:Math.max(0,Date.now()-(s.shownAt||Date.now()))};
  const {data,error}=await db().rpc('answer_question',payload);
  if(error){
    if(!navigator.onLine||/fetch|network|load failed/i.test(error.message||'')){state.pendingAttempts=state.pendingAttempts.filter(x=>!(x.p_session===payload.p_session&&x.p_question===payload.p_question));state.pendingAttempts.push(payload);s.answers[q.id]=letter;saveActive();notify('Sin conexión: respuesta guardada para reintentar.',5000);renderQuiz();return;}
    if(/FREE_LIMIT_REACHED/i.test(error.message||'')||error.code==='42501'){s.limitReached=true;saveActive();notify(humanError(error),6000);renderQuiz();return;}
    notify(humanError(error),5000);return;
  }
  s.answers[q.id]=letter;
  if(s.mode==='instant'){Object.assign(q,{correct_answer:data.correct_answer,explanation:data.explanation||'',galactic_tip:data.galactic_tip||''});s.revealed[q.id]=true;}
  saveActive();renderQuiz();
}

async function persistQuestionState(questionId){
  const s=state.active;if(!s)return;const payload={p_session:s.sessionId,p_question:questionId,p_marked:Boolean(s.marked[questionId]),p_discarded:s.discarded[questionId]||[]};const {error}=await db().rpc('save_question_state',payload);if(error&&/fetch|network|load failed/i.test(error.message||'')){state.pendingStates=state.pendingStates.filter(x=>!(x.p_session===payload.p_session&&x.p_question===payload.p_question));state.pendingStates.push(payload);saveActive();}else if(error)notify(humanError(error),4000);
}

async function flushPendingAttempts(){
  if(!navigator.onLine)return state.pendingAttempts.length===0&&state.pendingStates.length===0;if(!state.pendingAttempts.length&&!state.pendingStates.length)return true;
  const left=[];for(const p of state.pendingAttempts){const {data,error}=await db().rpc('answer_question',p);if(error){if(/FREE_LIMIT_REACHED/i.test(error.message||'')){if(state.active){delete state.active.answers[p.p_question];state.active.limitReached=true;}notify('Una respuesta pendiente no se registró porque alcanzaste el límite diario.',6000);}else left.push(p);continue;}const q=state.active?.questions?.find(x=>x.id===p.p_question);if(q&&state.active?.mode==='instant'){Object.assign(q,{correct_answer:data.correct_answer,explanation:data.explanation||'',galactic_tip:data.galactic_tip||''});state.active.revealed[q.id]=true;}}
  state.pendingAttempts=left;const statesLeft=[];for(const p of state.pendingStates){const {error}=await db().rpc('save_question_state',p);if(error)statesLeft.push(p);}state.pendingStates=statesLeft;saveActive();if(!left.length&&!statesLeft.length)notify('Progreso pendiente sincronizado.');return !left.length&&!statesLeft.length;
}
async function toggleFavorite(questionId){
  const supa=db();const {data}=await supa.from('favorites').select('question_id').eq('user_id',state.user.id).eq('question_id',questionId).maybeSingle();
  if(data){await supa.from('favorites').delete().eq('user_id',state.user.id).eq('question_id',questionId);notify('Quitada de favoritas');}
  else{const {error}=await supa.from('favorites').insert({user_id:state.user.id,question_id:questionId});if(error)notify(humanError(error));else notify('Guardada en favoritas');}
}
async function loadNote(questionId){
  const {data}=await db().from('user_notes').select('note').eq('user_id',state.user.id).eq('question_id',questionId).maybeSingle();const t=document.getElementById('questionNote');if(t&&data)t.value=data.note||'';
}
async function saveNote(questionId,note,silent=false){const {error}=await db().from('user_notes').upsert({user_id:state.user.id,question_id:questionId,note},{onConflict:'user_id,question_id'});const status=document.getElementById('noteStatus');if(status)status.textContent=error?'No guardada':'Guardada';if(!silent)notify(error?humanError(error):'Nota guardada');}

async function loadHighlights(questionId){
  const {data,error}=await db().from('user_highlights').select('start_offset,end_offset,color').eq('user_id',state.user.id).eq('question_id',questionId).order('start_offset');if(error)return;
  const el=document.getElementById('questionStem'),q=currentQuestion();if(!el||q?.id!==questionId)return;
  const text=q.stem||'';let pos=0,html='';for(const h of data||[]){const a=Math.max(pos,Math.min(text.length,h.start_offset)),b=Math.max(a,Math.min(text.length,h.end_offset));html+=esc(text.slice(pos,a))+`<mark class="highlight-${esc(h.color)}">${esc(text.slice(a,b))}</mark>`;pos=b;}html+=esc(text.slice(pos));el.innerHTML=html;
}
async function saveSelectedHighlight(questionId){
  const root=document.getElementById('questionStem'),sel=window.getSelection();if(!root||!sel||sel.isCollapsed||!sel.rangeCount)return;
  const range=sel.getRangeAt(0);if(!root.contains(range.commonAncestorContainer))return;
  const before=document.createRange();before.selectNodeContents(root);before.setEnd(range.startContainer,range.startOffset);const start=before.toString().length,end=start+range.toString().length;sel.removeAllRanges();if(end<=start)return;
  const {error}=await db().from('user_highlights').upsert({user_id:state.user.id,question_id:questionId,start_offset:start,end_offset:end,color:'yellow'},{onConflict:'user_id,question_id,start_offset,end_offset'});if(error)notify(humanError(error));else loadHighlights(questionId);
}
async function clearHighlights(questionId){const {error}=await db().from('user_highlights').delete().eq('user_id',state.user.id).eq('question_id',questionId);if(error)notify(humanError(error));else{notify('Resaltados eliminados');loadHighlights(questionId);}}

async function finishStudy(byTime=false){
  const s=state.active;if(!s||s.finished)return;
  if(!byTime&&!confirm('¿Finalizar la sesión y ver resultados?'))return;
  const seconds=elapsed();clearInterval(renderQuiz.timer);
  if(!(await flushPendingAttempts())){notify('No se puede finalizar hasta sincronizar las respuestas pendientes. Revisa Internet.',6000);pauseTimer();return;}
  const {data,error}=await db().rpc('complete_study_session',{p_session:s.sessionId,p_elapsed:seconds});if(error){notify(humanError(error),6000);return;}
  s.finished=true;s.correct=Number(data.correct||0);s.blank=Number(data.blank||0);s.incorrect=Number(data.incorrect||0);s.elapsedSeconds=seconds;s.questions=data.questions||s.questions;s.questionIds=s.questions.map(q=>q.id);s.revealed=Object.fromEntries(s.questions.map(q=>[q.id,true]));s.resumedAt=null;saveActive();
  const award=await db().rpc('award_session_progress',{p_session_id:s.sessionId});
  if(award.error) console.warn('No se pudo asignar XP:',award.error.message);
  else if(award.data){state.profile={...state.profile,xp:award.data.xp??state.profile?.xp,streak:award.data.streak??state.profile?.streak};updateChrome();}
  state.lastResult=s;await go('results',true);
}
function renderResults(){
  const s=state.lastResult||state.active;if(!s||!s.finished){go('home',true);return;}
  const score=pct(s.correct,s.questions.length),penalty=Number(s.simulation?.penalty??.333),net=Math.round((s.correct-s.incorrect*penalty)*100)/100,note=Math.round((s.correct/s.questions.length)*2000)/100;
  app.innerHTML=`<section class="page"><div class="card" style="text-align:center"><div class="kicker">SESIÓN TERMINADA</div><h2>${s.type==='SIMULATION'?'Simulacro completado':'Banqueo completado'}</h2><div class="result-ring" style="--score:${score*3.6}deg"><span>${score}%</span></div><p class="muted">${s.correct} correctas · ${s.incorrect} incorrectas · ${s.blank} en blanco · ${timeText(s.elapsedSeconds||0)}</p><div class="pill-row" style="justify-content:center"><span class="tag">Netas: ${net}</span><span class="tag">Nota vigesimal: ${note}/20</span><span class="tag">Precisión: ${score}%</span></div><div class="cta-row" style="justify-content:center"><button id="newSession" class="btn btn-primary">Nuevo banqueo</button><button class="btn" data-go="stats">Ver progreso</button></div></div>
  <div class="section-head"><div><h2>Revisión final</h2><p class="muted">Tu respuesta, clave oficial, explicación y dato clave.</p></div></div><div class="grid">${s.questions.map((q,i)=>{const a=s.answers[q.id],ok=a===q.correct_answer;return `<div class="card review-card ${ok?'correct':'wrong'}"><div class="space-between"><strong>${i+1}. ${esc(q.external_id)}</strong><span class="tag">Tu respuesta: ${a?`${esc(a)} · ${esc(q.options?.[a]||'')}`:'—'} · Clave: ${q.correct_answer||'—'}</span></div><p>${esc(q.stem)}</p>${q.image_url?`<img class="question-image" src="${esc(resolveImage(q.image_url))}" />`:''}<div class="explanation"><div class="explanation-title">${ok?'✅ Correcta':'❌ Revisa'} · Respuesta ${esc(q.correct_answer||'—')}</div><div><strong>Explicación:</strong> ${q.explanation?esc(q.explanation):'<span class="muted">Sin explicación cargada todavía.</span>'}</div>${q.galactic_tip?`<div class="key-fact"><strong>Dato clave:</strong> ${esc(q.galactic_tip)}</div>`:''}</div></div>`}).join('')}</div></section>`;
  bindGo();const n=document.getElementById('newSession');if(n)n.onclick=()=>{state.active=null;state.lastResult=null;saveActive();go('practice',true)};
}

async function renderErrors(){
  const supa=db();
  const {data,error}=await supa.rpc('user_attempt_history',{p_limit:1000});
  if(error) throw error;
  const latest=new Map(),wrongCounts=new Map(),everWrong=new Map();let unavailable=0;
  for(const row of data||[]){if(!latest.has(row.question_id))latest.set(row.question_id,row);if(row.is_correct===false){wrongCounts.set(row.question_id,(wrongCounts.get(row.question_id)||0)+1);if(row.question?.id)everWrong.set(row.question_id,row.question);else unavailable++;}}
  const unresolved=[...latest.values()].filter(x=>x.is_correct===false&&x.question?.id).map(x=>x.question),all=[...everWrong.values()];let unique=unresolved;
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">REPASO INTELIGENTE</div><h2>Mis errores</h2><p class="muted">Preguntas que respondiste mal al menos una vez. Se actualiza con tus intentos sincronizados.</p></div></div>
  <div class="grid grid-3"><div class="card stats-card"><span class="muted small">Errores por corregir</span><strong>${unresolved.length}</strong></div><div class="card stats-card"><span class="muted small">Falladas alguna vez</span><strong>${all.length}</strong></div><div class="card stats-card"><span class="muted small">Objetivo</span><strong>Corregir patrón</strong></div></div>${unavailable?`<div class="notice warning" style="margin-top:14px">${unavailable} registros de tu historial pertenecen a preguntas que ya no están disponibles.</div>`:''}
  <div class="card" style="margin-top:18px"><div class="space-between"><div><h3>Crear sesión desde tus errores</h3><p class="muted">BANQO toma primero los errores más recientes y evita repetir la misma pregunta dentro de la sesión.</p></div><div class="inline"><select id="errorCount"><option>5</option><option>10</option><option selected>15</option><option>20</option><option>30</option></select><button id="startErrors" class="btn btn-primary" ${unique.length?'':'disabled'}>Rebanquear errores</button></div></div></div>
  <div class="section-head"><div><h2>Detalle de errores</h2></div><select id="errorView"><option value="unresolved">Sólo las que sigo fallando</option><option value="all">Todas las que fallé alguna vez</option></select></div><div id="errorCards"></div></section>`;
  const draw=()=>{unique=document.getElementById('errorView')?.value==='all'?all:unresolved;const box=document.getElementById('errorCards');box.innerHTML=unique.length?`<div class="grid">${unique.slice(0,50).map(q=>`<details class="card error-detail"><summary><strong>${esc(q.external_id)}</strong> · ${esc(q.stem).slice(0,180)}${q.stem.length>180?'…':''} <span class="tag">${wrongCounts.get(q.id)||1} fallo(s)</span></summary><div class="options-static">${Object.entries(q.options||{}).map(([k,v])=>`<p><strong>${k}.</strong> ${esc(v)}</p>`).join('')}</div><div class="explanation"><strong>Clave: ${esc(q.correct_answer||'—')}</strong><p>${q.explanation?esc(q.explanation):'Esta pregunta todavía no tiene explicación.'}</p>${q.galactic_tip?`<div class="key-fact"><strong>Dato clave:</strong> ${esc(q.galactic_tip)}</div>`:''}</div></details>`).join('')}</div>`:'<div class="card empty">No hay errores en esta vista.</div>';const start=document.getElementById('startErrors');if(start)start.disabled=!unique.length;};draw();
  document.getElementById('errorView').onchange=draw;const btn=document.getElementById('startErrors');if(btn)btn.onclick=()=>startErrorPractice(document.getElementById('errorView').value==='all'?all:unresolved);
}

async function startErrorPractice(unique){
  setBusy(true);
  try{
    let count=Math.min(Number(document.getElementById('errorCount')?.value)||15,unique.length);
    const remaining=await freeRemaining();
    if(remaining<=0){notify('Ya alcanzaste el límite gratuito de hoy.',4500);return;}
    if(Number.isFinite(remaining) && count>remaining){count=remaining;notify(`Hoy te quedan ${remaining} preguntas gratuitas.`);}
    const ids=unique.slice(0,count).map(x=>x.id);if(!ids.length){notify('No hay errores disponibles');return;}
    const {data,error}=await db().rpc('start_practice',{p_count:count,p_mode:'instant',p_filters:{mode:'MIS_ERRORES'},p_random:false,p_question_ids:ids});if(error)throw error;
    const questions=data.questions||[];state.active={sessionId:data.session_id,type:'PRACTICE',mode:'instant',questions,questionIds:questions.map(x=>x.id),answers:{},revealed:{},marked:{},discarded:{},index:0,consumedSeconds:0,resumedAt:Date.now(),finished:false};saveActive();await go('quiz',true);
  }catch(e){notify(humanError(e),5000)}finally{setBusy(false)}
}

async function renderStats(){
  const supa=db();
  const [sessions,progress,favs,topics]=await Promise.all([
    supa.from('study_sessions').select('*').eq('user_id',state.user.id).eq('status','COMPLETADA').order('started_at',{ascending:false}).limit(30),
    supa.rpc('user_progress_summary'),
    supa.from('favorites').select('question_id',{count:'exact',head:true}).eq('user_id',state.user.id),
    supa.rpc('user_topic_progress')
  ]);
  const stats=progress.data||{total:0,correct:0};
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">PROGRESO</div><h2>Tu rendimiento</h2><p class="muted">Sincronizado con tu cuenta de Supabase.</p></div></div>
  <div class="grid grid-4"><div class="card stats-card"><span class="muted small">Respondidas</span><strong>${stats.total||0}</strong></div><div class="card stats-card"><span class="muted small">Correctas</span><strong>${stats.correct||0}</strong></div><div class="card stats-card"><span class="muted small">Precisión</span><strong>${pct(stats.correct||0,stats.total||0)}%</strong></div><div class="card stats-card"><span class="muted small">Favoritas</span><strong>${favs.count||0}</strong></div></div>
  <div class="section-head"><div><h2>Rendimiento por especialidad y tema</h2><p class="muted">Primero aparecen los temas con menor precisión.</p></div></div>${topics.data?.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Especialidad</th><th>Tema</th><th>Respondidas</th><th>Correctas</th><th>Precisión</th></tr></thead><tbody>${topics.data.map(x=>`<tr><td>${esc(x.specialty)}</td><td>${esc(x.topic)}</td><td>${x.total}</td><td>${x.correct}</td><td>${Math.round(Number(x.accuracy_pct)||0)}%</td></tr>`).join('')}</tbody></table></div>`:'<div class="card empty">Aún no hay datos por tema.</div>'}
  <div class="section-head"><div><h2>Sesiones recientes</h2></div></div>${sessions.data?.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Preguntas</th><th>Correctas</th><th>Incorrectas</th><th>Blanco</th><th>%</th></tr></thead><tbody>${sessions.data.map(x=>`<tr><td>${fmt(x.started_at)}</td><td>${esc(x.session_type)}</td><td>${(x.question_ids||[]).length}</td><td>${x.correct_count}</td><td>${x.incorrect_count}</td><td>${x.blank_count}</td><td>${Math.round(Number(x.score)||0)}%</td></tr>`).join('')}</tbody></table></div>`:'<div class="card empty">Aún no tienes sesiones completadas.</div>'}</section>`;
}

async function renderAdmin(){
  const isAdmin=state.profile?.role==='admin';if(!['admin','moderator'].includes(state.profile?.role)){await go('home',true);return;}
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">GESTIÓN BANQO</div><h2>Centro de contenido</h2><p class="muted">Revisa y administra el contenido según los permisos de tu rol.</p></div><span class="badge-admin">${isAdmin?'ADMIN':'MODERADOR'}</span></div>
    <div class="admin-tabs"><button class="tab-btn ${state.adminTab==='questions'?'active':''}" data-admin-tab="questions">Preguntas</button>${isAdmin?`<button class="tab-btn ${state.adminTab==='import'?'active':''}" data-admin-tab="import">Importar</button>`:''}<button class="tab-btn ${state.adminTab==='simulations'?'active':''}" data-admin-tab="simulations">Simulacros</button><button class="tab-btn ${state.adminTab==='reports'?'active':''}" data-admin-tab="reports">Reportes</button>${isAdmin?`<button class="tab-btn ${state.adminTab==='batches'?'active':''}" data-admin-tab="batches">Lotes</button><button class="tab-btn ${state.adminTab==='users'?'active':''}" data-admin-tab="users">Usuarios</button>`:''}</div><div id="adminContent"></div></section>`;
  document.querySelectorAll('[data-admin-tab]').forEach(b=>b.onclick=async()=>{state.adminTab=b.dataset.adminTab;await renderAdmin()});
  await loadAdminTab();
}
async function loadAdminTab(){
  if(!document.getElementById('adminContent')) return;
  if(state.adminTab==='questions')await renderAdminQuestions();
  else if(state.adminTab==='import')renderAdminImport();
  else if(state.adminTab==='simulations')await renderAdminSimulations();
  else if(state.adminTab==='reports')await renderAdminReports();
  else if(state.adminTab==='batches')await renderAdminBatches();
  else if(state.adminTab==='users')await renderAdminUsers();
  else await renderAdminQuestions();
}

async function renderAdminQuestions(){
  const el=document.getElementById('adminContent');if(!el)return;el.innerHTML='<div class="card">Cargando...</div>';
  const supa=db();
  const [total,pending,published,reports]=await Promise.all([
    supa.from('questions').select('id',{count:'exact',head:true}),supa.from('questions').select('id',{count:'exact',head:true}).eq('status','PENDIENTE'),supa.from('questions').select('id',{count:'exact',head:true}).eq('status','PUBLICADA'),supa.from('question_reports').select('id',{count:'exact',head:true}).eq('status','PENDIENTE')
  ]);
  el.innerHTML=`<div class="grid grid-4"><div class="card stats-card"><span class="muted small">Total</span><strong>${total.count||0}</strong></div><div class="card stats-card"><span class="muted small">Pendientes</span><strong>${pending.count||0}</strong></div><div class="card stats-card"><span class="muted small">Publicadas</span><strong>${published.count||0}</strong></div><div class="card stats-card"><span class="muted small">Reportes</span><strong>${reports.count||0}</strong></div></div>
  <div class="section-head"><div><h2>Preguntas</h2></div></div><div class="card"><div class="admin-toolbar"><div class="field"><label>Buscar</label><input id="aqSearch" placeholder="ID o texto" /></div><div class="field"><label>Estado</label><select id="aqStatus"><option value="">Todos</option><option>PENDIENTE</option><option>APROBADA</option><option>PUBLICADA</option><option>ARCHIVADA</option></select></div><div class="field"><label>Explicación</label><select id="aqExplanation"><option value="">Todas</option><option value="AUTO_LOCAL">Automática por revisar</option><option value="MANUAL">Manual/revisada</option><option value="IA">IA</option></select></div><button id="aqLoad" class="btn btn-primary">Buscar</button></div><div id="aqTable" style="margin-top:14px"></div></div>
  ${state.profile?.role==='admin'?`<div class="card danger-zone"><div><h3>Gestión masiva</h3><p class="muted small"><strong>Archivar</strong> conserva el historial. <strong>Eliminar</strong> borra también intentos, estadísticas, notas, favoritos y reportes asociados de todos los alumnos.</p></div><div class="inline"><button id="archiveAllQuestions" class="btn" ${total.count?'':'disabled'}>Archivar todas</button><button id="deleteAllQuestions" class="btn btn-danger" ${total.count?'':'disabled'}>Eliminar todas</button></div></div>`:''}`;
  const aqLoad=document.getElementById('aqLoad');if(aqLoad)aqLoad.onclick=loadAdminQuestionsTable;
  const delAll=document.getElementById('deleteAllQuestions');if(delAll)delAll.onclick=deleteAllQuestions;
  const archiveAll=document.getElementById('archiveAllQuestions');if(archiveAll)archiveAll.onclick=archiveAllQuestions;
  await loadAdminQuestionsTable();
}
async function archiveAllQuestions(){if(!confirm('¿Archivar todas las preguntas? El historial de alumnos se conservará.'))return;const {error}=await db().from('questions').update({status:'ARCHIVADA',archived_at:new Date().toISOString(),updated_by:state.user.id}).neq('status','ARCHIVADA');if(error)notify(humanError(error));else{await db().from('simulation_sets').update({status:'BORRADOR'}).eq('status','PUBLICADO');notify('Preguntas archivadas; progreso conservado.');renderAdminQuestions();}}
async function loadAdminQuestionsTable(){
  const box=document.getElementById('aqTable');if(!box)return;box.innerHTML='Cargando...';
  const status=document.getElementById('aqStatus')?.value||'',term=document.getElementById('aqSearch')?.value.trim()||'',explanation=document.getElementById('aqExplanation')?.value||'';
  const {data,error}=await db().rpc('staff_list_questions',{p_search:term,p_status:status,p_limit:120,p_explanation_source:explanation});if(error){box.innerHTML=`<div class="danger-text">${esc(humanError(error))}</div>`;return;}
  box.innerHTML=(data||[]).length?`<div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>Examen/Banco</th><th>Pregunta</th><th>Clave</th><th>Estado</th><th></th></tr></thead><tbody>${data.map(x=>`<tr><td><span class="code">${esc(x.external_id)}</span><br><span class="muted small">v${x.version||1}</span></td><td>${esc(x.exam_type)}<br><span class="muted small">${esc(x.bank_name)}</span></td><td class="admin-question-stem">${esc(x.stem).slice(0,260)}${x.stem.length>260?'…':''}${x.requires_image&&!x.image_url?'<br><span class="warning-text small">⚠ imagen pendiente</span>':''}</td><td><strong>${esc(x.correct_answer||'—')}</strong></td><td class="status ${x.status==='PUBLICADA'?'ok':x.status==='PENDIENTE'?'warn':''}">${esc(x.status)}</td><td><button class="btn btn-soft" data-edit-q="${x.id}">Editar</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Sin resultados.</div>';
  document.querySelectorAll('[data-edit-q]').forEach(b=>b.onclick=()=>openQuestionEditor(b.dataset.editQ));
}

async function deleteAllQuestions(){
  const supa=db();
  const {count,error}=await supa.from('questions').select('id',{count:'exact',head:true});
  if(error){notify(humanError(error),5000);return;}
  if(!count){notify('No hay preguntas para eliminar');return;}
  if(!confirm(`Vas a eliminar ${count} preguntas y también todos los intentos, estadísticas, notas, favoritos y reportes asociados. Esta acción no se puede deshacer. ¿Continuar?`))return;
  const typed=prompt('Para confirmar, escribe exactamente: ELIMINAR TODO');
  if(typed!=='ELIMINAR TODO'){notify('Eliminación cancelada');return;}
  setBusy(true);
  try{
    // import_items tiene una referencia opcional a questions; la soltamos antes de borrar.
    const unlink=await supa.from('import_items').update({linked_question_id:null}).not('linked_question_id','is',null);
    if(unlink.error) throw unlink.error;
    let removed=0,rounds=0;
    while(true){
      if(++rounds>200)throw new Error('Demasiadas iteraciones. Revisa permisos de borrado.');
      const {data:ids,error:readErr}=await supa.from('questions').select('id').limit(500);
      if(readErr)throw readErr;
      if(!ids?.length)break;
      const {error:delErr}=await supa.from('questions').delete().in('id',ids.map(x=>x.id));
      if(delErr)throw delErr;
      removed+=ids.length;
    }
    // Al borrar questions, simulation_questions se limpia por cascade. Dejamos la definición del simulacro en borrador y con 0 preguntas.
    const reset=await supa.from('simulation_sets').update({question_count:0,status:'BORRADOR'}).not('id','is',null);
    if(reset.error)console.warn('No se pudieron resetear todos los simulacros:',reset.error.message);
    state.active=null;saveActive();
    notify(`Se eliminaron ${removed} preguntas.`,5000);
    await renderAdminQuestions();
  }catch(e){console.error(e);notify(humanError(e),6000)}finally{setBusy(false)}
}

function renderAdminImport(){
  const el=document.getElementById('adminContent');if(!el)return;
  el.innerHTML=`<div class="grid"><div class="card"><div class="section-head" style="margin-top:0"><div><h2>Importar preguntas o simulacros</h2><p class="muted">Reconoce PDFs a 1 o 2 columnas, respuestas marcadas en verde y PDFs escaneados mediante OCR. Después genera Explicación + Dato clave localmente, sin API y sin costo.</p></div></div>
  <div class="form-grid-3"><div class="field"><label>Tipo</label><select id="iBankType"><option value="BANCO">Banco de preguntas</option><option value="SIMULACRO">Simulacro</option></select></div><div class="field"><label>Examen</label><select id="iExam">${APP_CONFIG.exams.map(x=>`<option value="${x.value}">${x.label}</option>`).join('')}</select></div><div class="field"><label>Año</label><input id="iYear" type="number" placeholder="2026" /></div><div class="field"><label>Nombre</label><input id="iName" placeholder="Ej. Banco Histórico - Cardiología" /></div><div class="field"><label>Prefijo ID</label><input id="iPrefix" placeholder="Ej. CARDIO1 o SIM1" /></div><div class="field"><label>Duración (min, solo simulacro)</label><input id="iDuration" type="number" placeholder="Opcional" /></div><div class="field"><label>Especialidad por defecto</label><input id="iSpec" placeholder="Sin clasificar" /></div><div class="field"><label>Tema por defecto</label><input id="iTopic" placeholder="Sin clasificar" /></div><div class="field"><label>Subtema por defecto</label><input id="iSubtopic" placeholder="Sin clasificar" /></div></div>
  <label class="checkbox" style="margin-top:14px"><input id="iAutoExplain" type="checkbox" checked /> Generar automáticamente <strong>Explicación + Dato clave</strong> de forma local y gratuita después de detectar la respuesta correcta.</label>
  <div class="dropzone" style="margin-top:15px"><div class="form-grid"><div class="field"><label>Archivo principal</label><input id="importFile" type="file" accept=".xlsx,.xls,.csv,.json,.pdf" /><span class="muted small">Preguntas, banco o solucionario con preguntas completas.</span></div><div class="field"><label>PDF de claves / solucionario (opcional)</label><input id="answerKeyFile" type="file" accept=".pdf" /><span class="muted small">Úsalo cuando las preguntas y las claves vienen en archivos separados.</span></div></div><p class="muted small">BANQO cruza las claves por número de pregunta. Todo queda en PENDIENTE para revisión.</p><button id="parseImport" class="btn btn-primary">Analizar archivo</button></div>
  <div class="divider"></div><div class="inline"><strong>Ejemplos:</strong><button class="btn btn-soft" data-sample="bio">Bioética 1</button><button class="btn btn-soft" data-sample="sim">Simulacro 1</button></div></div><div id="importPreview"></div></div>`;
  const parseImport=document.getElementById('parseImport');if(parseImport)parseImport.onclick=analyseImportFile;
  document.querySelectorAll('[data-sample]').forEach(b=>b.onclick=()=>loadSampleImport(b.dataset.sample));
  if(state.importPreview)renderImportPreview();
}
function currentImportMeta(){return {bankType:document.getElementById('iBankType')?.value||'BANCO',examType:document.getElementById('iExam')?.value||'RESIDENTADO',year:document.getElementById('iYear')?.value||null,bankName:document.getElementById('iName')?.value.trim()||'BANQO',prefix:document.getElementById('iPrefix')?.value.trim()||'BANQO',duration:Number(document.getElementById('iDuration')?.value)||null,specialty:document.getElementById('iSpec')?.value.trim()||'Sin clasificar',topic:document.getElementById('iTopic')?.value.trim()||'Sin clasificar',subtopic:document.getElementById('iSubtopic')?.value.trim()||'Sin clasificar'};}
async function analyseImportFile(){
  const file=document.getElementById('importFile')?.files?.[0];if(!file){notify('Selecciona un archivo principal');return;}
  const keyFile=document.getElementById('answerKeyFile')?.files?.[0]||null;
  const autoExplain=Boolean(document.getElementById('iAutoExplain')?.checked);
  const meta=currentImportMeta();if(!meta.bankName||!meta.prefix){notify('Indica nombre y prefijo');return;}
  state.currentImportFile=file;state.currentAnswerFile=keyFile;state.answerKeyStats=null;state.importMeta=meta;state.aiGeneration={attempted:false,generated:0,skipped:0,error:null};const box=document.getElementById('importPreview');box.innerHTML='<div class="card">Analizando...</div>';setBusy(true);
  const progress=p=>{if(!box)return;box.innerHTML=`<div class="card"><strong>${esc(p.stage||'Analizando')}</strong>${p.page?`<p class="muted">Página ${p.page} de ${p.total}</p><div class="progress-line"><span style="width:${pct(p.page,p.total)}%"></span></div>`:''}${p.done!==undefined?`<p class="muted small">${p.done} de ${p.totalItems}</p><div class="progress-line"><span style="width:${pct(p.done,p.totalItems)}%"></span></div>`:''}</div>`};
  try{
    let questions=await parseFile(file,meta,progress);
    if(keyFile){
      const keyMap=await parseAnswerKeyPdf(keyFile,meta,progress);
      const merged=await mergeAnswerKey(questions,keyMap,keyFile.name);questions=merged.questions;
      state.answerKeyStats={matched:merged.matched,conflicts:merged.conflicts||0,totalKeys:merged.totalKeys,matchRate:merged.matchRate||0};
    }
    state.importPreview=questions;state.importValidation=validateQuestions(questions);
    if(autoExplain){await generateMissingExplanations(questions,progress);state.importValidation=validateQuestions(questions);}
    renderImportPreview();
  }catch(e){console.error(e);box.innerHTML=`<div class="card"><h3>Error de importación</h3><p class="danger-text">${esc(humanError(e))}</p><p class="muted small">Si es un PDF escaneado, el OCR puede tardar más y requiere conexión a Internet.</p></div>`;}finally{setBusy(false)}
}

function localClean(value=''){
  return String(value??'').replace(/\s+/g,' ').trim();
}

function localSentenceParts(stem=''){
  const text=localClean(stem)
    .replace(/^\s*\d+[.)-]\s*/,'')
    .replace(/\b(?:señale|marque|indique|cuál|cual|qué|que)\s+(?:es|sería|seria|de las siguientes|la siguiente).*$/i,'')
    .trim();
  const raw=(text.match(/[^.;:!?→•·]+[.;:!?]?/g)||[]).map(localClean).filter(Boolean);
  const seen=new Set();
  return raw.filter(x=>{
    const k=x.toLowerCase();
    if(k.length<7||seen.has(k))return false;
    seen.add(k);return true;
  });
}

function clueScore(t=''){
  let n=0;
  if(/\d/.test(t))n+=3;
  if(/\b(?:años|meses|días|horas|mmhg|mg\/dl|g\/dl|meq|lpm|sat|spo2|fevi|ecg|ekg|tac|tc|rm|eco|mapa|hcg|cd4|pcr|cultivo|biopsia|fiebre|dolor|disnea|edema|hematuria|proteinuria|hiper|hipo|positivo|negativo|normal|elevad|disminuid|ausencia|presencia|antecedente|tratamiento|embarazo|diabetes|cáncer|cancer|infección|infeccion)\b/i.test(t))n+=3;
  if(/\b(?:sin|no|nunca|normal|negativ|descarta|excepto)\b/i.test(t))n+=2;
  n+=Math.min(2,Math.floor(t.length/70));
  return n;
}

function extractLocalClues(stem=''){
  const parts=localSentenceParts(stem).sort((a,b)=>clueScore(b)-clueScore(a));
  const selected=[];let chars=0;
  for(const p of parts){
    if(selected.length>=3)break;
    const cut=p.length>125?p.slice(0,122)+'…':p;
    if(chars+cut.length>260&&selected.length)continue;
    selected.push(cut);chars+=cut.length;
  }
  if(!selected.length){
    const x=localClean(stem);if(x)selected.push(x.length>180?x.slice(0,177)+'…':x);
  }
  return selected;
}

function localQuestionIntent(stem=''){
  const x=localClean(stem).toLowerCase();
  if(/diagn[oó]stic|corresponde a|compatible con|se trata de|cuadro cl[ií]nico/.test(x))return 'diagnóstico';
  if(/tratamiento|manejo|conducta|terapia|f[aá]rmaco|elecci[oó]n|indicado/.test(x))return 'tratamiento o conducta';
  if(/prueba|estudio|examen|confirmar|siguiente paso diagn[oó]stico/.test(x))return 'prueba o siguiente paso';
  if(/complicaci[oó]n|efecto adverso|reacci[oó]n adversa/.test(x))return 'complicación o efecto';
  if(/factor de riesgo|asociad|predispone/.test(x))return 'asociación o factor de riesgo';
  if(/mecanismo|fisiopatolog|receptor|enzima|acci[oó]n/.test(x))return 'mecanismo';
  if(/pron[oó]stico|mortalidad|supervivencia/.test(x))return 'pronóstico';
  return 'concepto preguntado';
}

function buildLocalExplanation(q){
  const letter=String(q.correct_answer||'').toUpperCase();
  const answer=localClean(q.options?.[letter]||'');
  if(!letter||!answer)return null;
  const clues=extractLocalClues(q.stem);
  const clueText=clues.join(' + ');
  const intent=localQuestionIntent(q.stem);
  const explanation=`Datos orientadores del enunciado: ${clueText}. Lo que se pregunta: ${intent}. Clave oficial: ${letter}. Pendiente de revisión editorial.`;
  const keyFact=`Clave oficial ${letter}. Ayuda automática pendiente de revisión.`;
  return {explanation,keyFact};
}

async function generateMissingExplanations(questions,onProgress=()=>{}){
  const pending=(questions||[]).filter(q=>q.correct_answer && (!q.explanation || !q.galactic_tip));
  state.aiGeneration={attempted:true,generated:0,skipped:(questions||[]).length-pending.length,error:null,mode:'local'};
  if(!pending.length)return state.aiGeneration;
  try{
    for(let i=0;i<pending.length;i++){
      const q=pending[i];
      onProgress({stage:'Generando explicación + dato clave local (gratis)',done:i,totalItems:pending.length});
      const out=buildLocalExplanation(q);
      if(!out)continue;
      if(!q.explanation)q.explanation=out.explanation;
      if(!q.galactic_tip)q.galactic_tip=out.keyFact;
      q.explanation_source='AUTO_LOCAL';
      q._localExplanationGenerated=true;
      q.source_hash=await sha256(JSON.stringify({stem:q.stem,options:q.options,answer:q.correct_answer,explanation:q.explanation,galactic_tip:q.galactic_tip}));
      state.aiGeneration.generated++;
      if(i%35===0)await sleep(0);
    }
    onProgress({stage:'Explicaciones locales generadas',done:pending.length,totalItems:pending.length});
  }catch(e){
    console.warn('Local explanation generation failed:',e);
    state.aiGeneration.error=e?.message||String(e);
  }
  return state.aiGeneration;
}

async function retryAiExplanations(){
  if(!state.importPreview?.length)return;setBusy(true);const box=document.getElementById('importPreview');
  const progress=p=>{if(box)box.innerHTML=`<div class="card"><strong>${esc(p.stage||'Generando localmente')}</strong>${p.done!==undefined?`<p class="muted small">${p.done} de ${p.totalItems}</p><div class="progress-line"><span style="width:${pct(p.done,p.totalItems)}%"></span></div>`:''}</div>`};
  try{await generateMissingExplanations(state.importPreview,progress);state.importValidation=validateQuestions(state.importPreview);renderImportPreview();}finally{setBusy(false)}
}

async function loadSampleImport(kind){
  const path=kind==='bio'?'data/sample_bioetica1.json':'data/sample_simulacro1.json';const data=await (await fetch(path)).json();state.importPreview=data;state.importValidation=validateQuestions(data);state.currentImportFile=null;state.currentAnswerFile=null;state.answerKeyStats=null;state.aiGeneration={attempted:false,generated:0,skipped:0,error:null};state.importMeta={bankType:kind==='bio'?'BANCO':'SIMULACRO',examType:'RESIDENTADO',year:null,bankName:kind==='bio'?'Banco Histórico - Bioética 1':'Simulacro 1',prefix:kind==='bio'?'BIO1':'SIM1',duration:null,specialty:kind==='bio'?'Salud Pública y Gestión':'Sin clasificar',topic:kind==='bio'?'Bioética y Deontología':'Sin clasificar',subtopic:kind==='bio'?'Bioética':'Sin clasificar'};renderImportPreview();
}
function renderImportPreview(){
  const box=document.getElementById('importPreview');if(!box||!state.importPreview)return;const v=state.importValidation||validateQuestions(state.importPreview),s=v.summary;
  const critical=v.rows.filter(r=>r.errors.length).slice(0,80);
  const keyInfo=state.answerKeyStats?`<div class="notice ${state.answerKeyStats.matchRate<.9||state.answerKeyStats.conflicts?'warning':'success'}"><strong>Claves cruzadas:</strong> ${state.answerKeyStats.matched} coincidencias de ${s.total} preguntas (${Math.round(state.answerKeyStats.matchRate*100)}%). ${state.answerKeyStats.conflicts||0} conflicto(s).${state.answerKeyStats.matchRate<.9?' La numeración probablemente no coincide; revisa antes de importar.':''}</div>`:'';
  const missingInfo=s.missingNumbers?`<div class="notice warning"><strong>Numeración incompleta:</strong> faltan ${s.missingNumbers} números: ${s.missingNumberList.join(', ')}${s.missingNumbers>s.missingNumberList.length?'…':''}</div>`:'';
  const issues=critical.length?`<details class="issue-panel" open><summary><strong>${critical.length}${v.rows.filter(r=>r.errors.length).length>critical.length?'+' : ''} preguntas con error crítico</strong></summary><div class="issue-grid">${critical.map(r=>`<div><span class="code">${esc(r.question.external_id)}</span> — ${r.errors.map(esc).join(' · ')}</div>`).join('')}</div></details>`:'';
  const ai=state.aiGeneration||{};
  const aiInfo=ai.attempted?(ai.error?`<div class="notice warning ai-status"><strong>Generador local:</strong> ${esc(ai.error)}<button id="retryAi" class="btn btn-soft" style="margin-top:9px">Reintentar</button></div>`:`<div class="notice success ai-status"><strong>Generador local gratuito:</strong> ${ai.generated||0} preguntas completadas con explicación + dato clave. <span class="small">Revísalas antes de publicar: el sistema no usa IA externa ni inventa una clave distinta.</span></div>`):`<div class="notice ai-status"><strong>Explicación automática local:</strong> genera una ayuda de estudio sin API ni costo y sin cambiar la clave oficial.<button id="retryAi" class="btn btn-soft" style="margin-left:9px">Generar ahora</button></div>`;
  box.innerHTML=`<div class="card"><div class="space-between"><div><div class="kicker">PREVISUALIZACIÓN</div><h2>${state.importPreview.length} preguntas detectadas</h2></div><button id="commitImport" class="btn btn-primary">Importar a Supabase</button></div>
  <div class="import-status" style="margin:16px 0"><div class="mini-stat"><span class="muted small">Total</span><strong>${s.total}</strong></div><div class="mini-stat"><span class="muted small">Sin error crítico</span><strong>${s.valid}</strong></div><div class="mini-stat"><span class="muted small">Con error</span><strong>${s.errors}</strong></div><div class="mini-stat"><span class="muted small">Sin verde</span><strong>${Math.max(0,s.missingAnswer-(s.ambiguousGreen||0)-(s.keyConflicts||0))}</strong></div><div class="mini-stat"><span class="muted small">Verde ambiguo</span><strong>${s.ambiguousGreen||0}</strong></div><div class="mini-stat"><span class="muted small">Conflicto de clave</span><strong>${s.keyConflicts||0}</strong></div><div class="mini-stat"><span class="muted small">Clave dudosa</span><strong>${s.lowConfidence||0}</strong></div><div class="mini-stat"><span class="muted small">Imagen pendiente</span><strong>${s.needsImage}</strong></div></div>
  ${keyInfo}${aiInfo}${missingInfo}${issues}
  <div class="notice warning"><strong>Seguridad editorial:</strong> una ayuda AUTO_LOCAL no se muestra al alumno hasta ser revisada y guardada como MANUAL. Los conflictos de clave fuerzan revisión humana. Ninguna pregunta nueva se publica automáticamente.</div>
  <div class="import-preview table-wrap" style="margin-top:13px"><table class="table"><thead><tr><th>#</th><th>ID</th><th>Pregunta</th><th>Clave</th><th>Explicación / dato</th><th>Validación</th></tr></thead><tbody>${v.rows.slice(0,300).map((r,i)=>`<tr class="${r.errors.length?'row-error':r.warnings.length?'row-warning':''}"><td>${r.question._order||i+1}</td><td><span class="code">${esc(r.question.external_id)}</span></td><td>${esc(r.question.stem).slice(0,220)}</td><td><strong>${esc(r.question.correct_answer||'—')}</strong>${r.question._keyConfidence!==undefined?`<br><span class="small muted">${Math.round((r.question._keyConfidence||0)*100)}%</span>`:''}</td><td>${r.question.explanation?'<span class="success-text">✓ explicación</span>':'<span class="warning-text">—</span>'}<br>${r.question.galactic_tip?'<span class="success-text">✓ dato clave</span>':'<span class="warning-text">—</span>'}</td><td>${r.errors.length?`<div class="danger-text">${r.errors.map(esc).join('<br>')}</div>`:''}${r.warnings.length?`<div class="warning-text">${r.warnings.map(esc).join('<br>')}</div>`:'<span class="success-text">OK</span>'}</td></tr>`).join('')}</tbody></table></div></div>`;
  const commitImportBtn=document.getElementById('commitImport');if(commitImportBtn)commitImportBtn.onclick=commitImport;
  const retry=document.getElementById('retryAi');if(retry)retry.onclick=retryAiExplanations;
}

async function commitImport(){
  if(!state.importPreview?.length)return;
  const byId=new Map(),richness=x=>Object.keys(x.options||{}).length*1000+(x.correct_answer?300:0)+(x.stem?.length||0);
  for(const q of state.importPreview){const old=byId.get(q.external_id);if(!old||richness(q)>richness(old))byId.set(q.external_id,q);}
  const importQuestions=[...byId.values()],duplicates=state.importPreview.length-importQuestions.length;
  if(duplicates&&!confirm(`Se detectaron ${duplicates} IDs duplicados. Se importará sólo la versión más completa de cada ID. ¿Continuar?`))return;
  if(!confirm(`¿Importar ${importQuestions.length} preguntas a Supabase? Las nuevas quedarán PENDIENTE y las modificadas conservarán su estado salvo cambio de texto, opciones o clave.`))return;
  setBusy(true);const supa=db();
  try{
    const meta=state.importMeta||currentImportMeta();
    const importType=!state.currentImportFile?'JSON':state.currentImportFile.name.toLowerCase().endsWith('.pdf')?'PDF_RESALTADO':state.currentImportFile.name.toLowerCase().endsWith('.json')?'JSON':state.currentImportFile.name.toLowerCase().endsWith('.csv')?'CSV':'XLSX';
    const {data:batch,error:be}=await supa.from('import_batches').insert({import_type:importType,bank_type:meta.bankType,exam_type:meta.examType,name:meta.bankName,file_name:state.currentImportFile?.name||'ejemplo-integrado.json',status:'IMPORTANDO',total_rows:importQuestions.length,metadata:{...meta,answer_key_file:state.currentAnswerFile?.name||null,answer_key_matched:state.answerKeyStats?.matched||0,duplicates_removed:duplicates},created_by:state.user.id}).select().single();if(be)throw be;
    let storagePath=null;
    if(state.currentImportFile){storagePath=`${state.user.id}/${batch.id}/${state.currentImportFile.name.replace(/[^A-Za-z0-9._-]/g,'_')}`;const up=await supa.storage.from('import-files').upload(storagePath,state.currentImportFile,{upsert:true});if(up.error)console.warn('No se pudo guardar archivo fuente:',up.error.message);else await supa.from('import_batches').update({storage_path:storagePath}).eq('id',batch.id);}
    if(state.currentAnswerFile){const keyPath=`${state.user.id}/${batch.id}/CLAVES_${state.currentAnswerFile.name.replace(/[^A-Za-z0-9._-]/g,'_')}`;const keyUp=await supa.storage.from('import-files').upload(keyPath,state.currentAnswerFile,{upsert:true});if(keyUp.error)console.warn('No se pudo guardar el archivo de claves:',keyUp.error.message);}
    for(const q of importQuestions){if(q._imageDataUrl&&!q.image_url){try{q.image_url=await uploadImportedImage(q,batch.id);q._imageUploadFailed=false;}catch(e){q._imageUploadFailed=true;q.review_notes=[q.review_notes,`No se pudo cargar el recorte automático: ${humanError(e)}`].filter(Boolean).join(' ');}}}
    const validation=validateQuestions(importQuestions);const issueMap=new Map(validation.rows.map(x=>[x.question.external_id,[...x.errors,...x.warnings]]));
    const existingMap=new Map();
    for(const part of chunk(importQuestions.map(x=>x.external_id),100)){const {data,error}=await supa.rpc('admin_questions_by_external',{p_ids:part});if(error)throw error;(data||[]).forEach(x=>existingMap.set(x.external_id,x));}
    const incomingIds=new Set(importQuestions.map(x=>x.external_id));
    const {data:bankExisting,error:bankError}=await supa.from('questions').select('external_id').eq('bank_name',meta.bankName).limit(5000);if(bankError)throw bankError;
    const sync={new:0,modified:0,unchanged:0,requeued:0,missing:(bankExisting||[]).filter(x=>!incomingIds.has(x.external_id)).length};
    const actions=new Map();
    const rows=[];
    for(const q of importQuestions){
      const prior=existingMap.get(q.external_id);
      if(prior && prior.source_hash && prior.source_hash===q.source_hash){sync.unchanged++;actions.set(q.external_id,'SIN_CAMBIOS');continue;}
      const copy=Object.fromEntries(Object.entries(q).filter(([k])=>!k.startsWith('_')));const issues=issueMap.get(q.external_id)||[];copy.review_notes=[copy.review_notes,issues.length?`Validación: ${issues.join(' | ')}`:''].filter(Boolean).join(' ');const substantive=prior&&(prior.correct_answer!==q.correct_answer||prior.stem!==q.stem||JSON.stringify(prior.options||{})!==JSON.stringify(q.options||{}));copy.status=!prior?'PENDIENTE':substantive?'PENDIENTE':prior.status;if(substantive&&prior.status==='PUBLICADA')sync.requeued++;copy.created_by=prior?undefined:state.user.id;copy.updated_by=state.user.id;
      if(copy.created_by===undefined) delete copy.created_by;
      if(prior){copy.version=(prior.version||1)+1;sync.modified++;actions.set(q.external_id,'MODIFICADA');}
      else{copy.version=1;sync.new++;actions.set(q.external_id,'NUEVA');}
      rows.push(copy);
    }
    const versionSnapshots=[];
    for(const q of importQuestions){const prior=existingMap.get(q.external_id);if(prior && actions.get(q.external_id)==='MODIFICADA')versionSnapshots.push({question_id:prior.id,version:prior.version||1,snapshot:prior,changed_by:state.user.id});}
    for(const part of chunk(versionSnapshots,100)){if(!part.length)continue;const {error}=await supa.from('question_versions').upsert(part,{onConflict:'question_id,version',ignoreDuplicates:true});if(error)throw error;}
    for(const part of chunk(rows,100)){if(!part.length)continue;const {error}=await supa.from('questions').upsert(part,{onConflict:'external_id'});if(error)throw error;}
    const idMap=new Map();for(const part of chunk(importQuestions.map(x=>x.external_id),100)){const {data,error}=await supa.from('questions').select('id,external_id').in('external_id',part);if(error)throw error;(data||[]).forEach(x=>idMap.set(x.external_id,x.id));}
    const importItems=importQuestions.map((q,i)=>{const action=actions.get(q.external_id)||'NUEVA';const issues=[...(issueMap.get(q.external_id)||[]),`Sincronización: ${action}`];return {batch_id:batch.id,row_number:q._order||i+1,external_id:q.external_id,raw_data:{source:state.currentImportFile?.name||'sample'},normalized_data:Object.fromEntries(Object.entries(q).filter(([k])=>!k.startsWith('_'))),status:action==='SIN_CAMBIOS'?'OMITIDO':'IMPORTADO',errors:issues,linked_question_id:idMap.get(q.external_id)||null};});
    for(const part of chunk(importItems,100)){const {error}=await supa.from('import_items').insert(part);if(error)console.warn(error);}
    if(meta.bankType==='SIMULACRO'){
      const code=(meta.prefix||meta.bankName).toUpperCase().replace(/[^A-Z0-9_-]/g,'-');
      const {data:sim,error}=await supa.from('simulation_sets').upsert({code,name:meta.bankName,exam_type:meta.examType,year:Number(meta.year)||null,duration_minutes:meta.duration||null,question_count:importQuestions.length,status:'BORRADOR',source_reference:state.currentImportFile?.name||meta.bankName,created_by:state.user.id},{onConflict:'code'}).select().single();if(error)throw error;
      await supa.from('simulation_questions').delete().eq('simulation_id',sim.id);
      const links=importQuestions.map((q,i)=>({simulation_id:sim.id,question_id:idMap.get(q.external_id),order_no:q._order||i+1,is_reserve:false})).filter(x=>x.question_id);
      for(const part of chunk(links,100)){const {error:e}=await supa.from('simulation_questions').insert(part);if(e)throw e;}
    }
    const report={...validation.summary,sync};
    await supa.from('import_batches').update({status:validation.summary.errors?'CON_ERRORES':'COMPLETADO',valid_rows:validation.summary.valid,error_rows:validation.summary.errors,report}).eq('id',batch.id);
    notify(`Importación: ${sync.new} nuevas · ${sync.modified} modificadas · ${sync.unchanged} sin cambios${sync.requeued?` · ${sync.requeued} republicación(es) requerida(s)`:''}.`,7000);state.importPreview=null;state.importValidation=null;state.currentImportFile=null;state.currentAnswerFile=null;state.answerKeyStats=null;state.adminTab='questions';await renderAdmin();
  }catch(e){console.error(e);notify(humanError(e),6000)}finally{setBusy(false)}
}

async function uploadImportedImage(q,batchId){
  const blob=await (await fetch(q._imageDataUrl)).blob();const safe=(q.external_id||'question').replace(/[^A-Za-z0-9_-]/g,'_');const path=`questions/import-${batchId}-${safe}.jpg`;
  const {error}=await db().storage.from('question-assets').upload(path,blob,{upsert:true,contentType:'image/jpeg'});if(error)throw error;return db().storage.from('question-assets').getPublicUrl(path).data?.publicUrl||null;
}

async function renderAdminSimulations(){
  const el=document.getElementById('adminContent');if(!el)return;const {data,error}=await db().from('simulation_sets').select('*').order('created_at',{ascending:false});if(error)throw error;
  const sims=data||[];await Promise.all(sims.map(async s=>{const r=await db().rpc('simulation_readiness',{p_sim:s.id});s.ready=r.data||{total:0,published:0,pending:0};}));
  el.innerHTML=`<div class="card"><div class="section-head" style="margin-top:0"><div><h2>Simulacros</h2><p class="muted">La publicación se bloquea si alguna pregunta aún no está PUBLICADA.</p></div></div>${sims.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Código</th><th>Nombre</th><th>Examen</th><th>Preparación</th><th>Duración</th><th>Estado</th><th></th></tr></thead><tbody>${sims.map(s=>`<tr><td><span class="code">${esc(s.code)}</span></td><td>${esc(s.name)}</td><td>${esc(s.exam_type)}</td><td>${s.ready.published||0}/${s.ready.total||0} publicadas${s.ready.pending?`<br><span class="warning-text">${s.ready.pending} pendientes</span>`:''}</td><td>${s.duration_minutes||'—'}</td><td class="status ${s.status==='PUBLICADO'?'ok':'warn'}">${s.status}</td><td>${state.profile?.role==='admin'?`<div class="inline">${s.ready.pending?`<button class="btn btn-soft" data-publish-sim-questions="${s.id}">Publicar ${s.ready.pending} preguntas</button>`:''}<button class="btn btn-soft" data-toggle-sim="${s.id}" data-status="${s.status}">${s.status==='PUBLICADO'?'Pasar a borrador':'Publicar simulacro'}</button></div>`:'Sólo lectura'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No hay simulacros.</div>'}</div>`;
  document.querySelectorAll('[data-toggle-sim]').forEach(b=>b.onclick=()=>toggleSimulation(b.dataset.toggleSim,b.dataset.status));
  document.querySelectorAll('[data-publish-sim-questions]').forEach(b=>b.onclick=async()=>{const {data,error}=await db().rpc('publish_simulation_questions',{p_sim:b.dataset.publishSimQuestions});if(error)notify(humanError(error));else{notify(`${data||0} preguntas publicadas.`);renderAdminSimulations();}});
}
async function toggleSimulation(id,status){const next=status==='PUBLICADO'?'BORRADOR':'PUBLICADO';if(next==='PUBLICADO'){const {data,error}=await db().rpc('simulation_readiness',{p_sim:id});if(error){notify(humanError(error));return;}if(Number(data?.published||0)<Number(data?.total||0)||!Number(data?.total||0)){notify(`Faltan ${data?.pending||0} preguntas por publicar. Usa el botón de publicación masiva primero.`,6000);return;}}const {error}=await db().from('simulation_sets').update({status:next}).eq('id',id);if(error)notify(humanError(error));else{notify(`Simulacro ${next.toLowerCase()}`);renderAdminSimulations();}}

async function renderAdminReports(){
  const el=document.getElementById('adminContent');if(!el)return;
  const {data,error}=await db().from('question_reports').select('id,reason,comment,status,created_at,user_id,questions(id,external_id,stem,status)').order('created_at',{ascending:false}).limit(100);
  if(error)throw error;
  el.innerHTML=`<div class="card"><div class="section-head" style="margin-top:0"><div><h2>Reportes de alumnos</h2><p class="muted">Errores de clave, OCR, actualización o imágenes reportados desde el banqueo.</p></div></div>${data?.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Pregunta</th><th>Motivo</th><th>Comentario</th><th>Estado</th><th></th></tr></thead><tbody>${data.map(r=>`<tr><td>${fmt(r.created_at)}</td><td><span class="code">${esc(r.questions?.external_id||'—')}</span><br><span class="muted small">${esc(r.questions?.stem||'').slice(0,160)}</span></td><td>${esc(r.reason)}</td><td>${esc(r.comment||'—')}</td><td class="status ${r.status==='PENDIENTE'?'warn':r.status==='RESUELTO'?'ok':''}">${esc(r.status)}</td><td><div class="inline"><button class="btn btn-soft" data-report-status="REVISADO" data-report-id="${r.id}">Revisado</button><button class="btn btn-soft" data-report-status="RESUELTO" data-report-id="${r.id}">Resolver</button>${r.questions?.id?`<button class="btn" data-edit-report-q="${r.questions.id}">Abrir pregunta</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No hay reportes.</div>'}</div>`;
  document.querySelectorAll('[data-report-status]').forEach(b=>b.onclick=async()=>{const {error}=await db().from('question_reports').update({status:b.dataset.reportStatus}).eq('id',b.dataset.reportId);if(error)notify(humanError(error));else renderAdminReports();});
  document.querySelectorAll('[data-edit-report-q]').forEach(b=>b.onclick=()=>openQuestionEditor(b.dataset.editReportQ));
}

async function renderAdminBatches(){
  const el=document.getElementById('adminContent');if(!el)return;const {data,error}=await db().from('import_batches').select('*').order('created_at',{ascending:false}).limit(50);if(error)throw error;
  el.innerHTML=`<div class="card"><div class="section-head" style="margin-top:0"><div><h2>Historial de importaciones</h2><p class="muted">Abre un lote para revisar errores por fila.</p></div></div>${data?.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Nombre</th><th>Tipo</th><th>Total</th><th>Válidas</th><th>Errores</th><th>Estado</th><th></th></tr></thead><tbody>${data.map(x=>`<tr><td>${fmt(x.created_at)}</td><td>${esc(x.name)}<br><span class="muted small">${esc(x.file_name||'')}</span>${x.report?.sync?`<br><span class="muted small">${x.report.sync.new||0} nuevas · ${x.report.sync.modified||0} mod. · ${x.report.sync.unchanged||0} iguales${x.report.sync.missing?` · ${x.report.sync.missing} ausentes`:''}</span>`:''}</td><td>${esc(x.import_type)} / ${esc(x.bank_type)}</td><td>${x.total_rows}</td><td>${x.valid_rows}</td><td>${x.error_rows}</td><td class="status ${x.status==='COMPLETADO'?'ok':x.status==='CON_ERRORES'?'warn':''}">${esc(x.status)}</td><td><button class="btn btn-soft" data-open-batch="${x.id}">Ver detalle</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Sin importaciones todavía.</div>'}</div>`;
  document.querySelectorAll('[data-open-batch]').forEach(b=>b.onclick=()=>openBatchDetails(b.dataset.openBatch));
}

async function openBatchDetails(batchId){
  const {data,error}=await db().from('import_items').select('id,row_number,external_id,status,errors,linked_question_id').eq('batch_id',batchId).order('row_number').limit(1000);if(error){notify(humanError(error));return;}
  openModal(`<div class="modal"><div class="space-between"><div><div class="kicker">LOTE</div><h2>Detalle de importación</h2></div><button class="btn" data-close-modal>Cerrar</button></div><div class="table-wrap" style="margin-top:15px"><table class="table"><thead><tr><th>Fila</th><th>ID</th><th>Estado</th><th>Validación</th><th></th></tr></thead><tbody>${(data||[]).map(x=>`<tr><td>${x.row_number||'—'}</td><td><span class="code">${esc(x.external_id||'—')}</span></td><td>${esc(x.status)}</td><td>${(x.errors||[]).map(esc).join('<br>')||'Sin incidencias'}</td><td>${x.linked_question_id?`<button class="btn btn-soft" data-batch-question="${x.linked_question_id}">Abrir pregunta</button>`:''}</td></tr>`).join('')}</tbody></table></div></div>`);
  document.querySelectorAll('[data-batch-question]').forEach(b=>b.onclick=()=>openQuestionEditor(b.dataset.batchQuestion));
}

async function renderAdminUsers(){
  const el=document.getElementById('adminContent');if(!el)return;el.innerHTML=`<div class="card"><div class="admin-toolbar"><div class="field"><label>Buscar usuario</label><input id="userSearch" placeholder="Correo o nombre"></div><button id="loadUsers" class="btn btn-primary">Buscar</button></div><div id="usersTable" style="margin-top:14px">Cargando…</div></div>`;
  const load=async()=>{const {data,error}=await db().rpc('admin_list_users',{p_search:document.getElementById('userSearch')?.value||''});const box=document.getElementById('usersTable');if(error){box.textContent=humanError(error);return;}box.innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Usuario</th><th>Rol</th><th>Plan</th><th></th></tr></thead><tbody>${(data||[]).map(u=>`<tr><td>${esc(u.full_name||'Sin nombre')}<br><span class="muted small">${esc(u.email)}</span></td><td><select data-user-role="${u.id}">${['student','moderator','admin'].map(r=>`<option ${u.role===r?'selected':''}>${r}</option>`).join('')}</select></td><td><select data-user-plan="${u.id}">${['free','pro','admin'].map(p=>`<option ${u.plan===p?'selected':''}>${p}</option>`).join('')}</select></td><td><button class="btn btn-soft" data-save-user="${u.id}">Guardar</button></td></tr>`).join('')}</tbody></table></div>`;document.querySelectorAll('[data-save-user]').forEach(b=>b.onclick=async()=>{const id=b.dataset.saveUser,role=document.querySelector(`[data-user-role="${id}"]`).value,plan=document.querySelector(`[data-user-plan="${id}"]`).value;const {error}=await db().rpc('admin_update_user',{p_user:id,p_role:role,p_plan:plan});notify(error?humanError(error):'Usuario actualizado');});};
  document.getElementById('loadUsers').onclick=load;await load();
}

async function openQuestionEditor(id){
  const {data:q,error}=await db().rpc('staff_get_question',{p_id:id});if(error||!q){notify(humanError(error||new Error('Pregunta no encontrada')));return;}
  const opts=q.options||{};
  modalRoot.innerHTML=`<div class="modal-backdrop"><div class="modal"><div class="space-between"><div><div class="kicker">${esc(q.external_id)}</div><h2>Editar pregunta</h2></div><button id="closeModal" class="btn">Cerrar</button></div>
    <div class="form-grid-3" style="margin-top:16px"><div class="field"><label>Examen</label><select id="eExam">${APP_CONFIG.exams.map(x=>`<option ${q.exam_type===x.value?'selected':''} value="${x.value}">${x.label}</option>`).join('')}</select></div><div class="field"><label>Banco</label><input id="eBank" value="${esc(q.bank_name)}" /></div><div class="field"><label>Año</label><input id="eYear" type="number" value="${q.year||''}" /></div><div class="field"><label>Especialidad</label><input id="eSpec" value="${esc(q.specialty)}" /></div><div class="field"><label>Tema</label><input id="eTopic" value="${esc(q.topic)}" /></div><div class="field"><label>Subtema</label><input id="eSub" value="${esc(q.subtopic)}" /></div></div>
    <div class="field" style="margin-top:12px"><label>Enunciado</label><textarea id="eStem" class="textarea-lg">${esc(q.stem)}</textarea></div>
    <div class="form-grid" style="margin-top:12px">${['A','B','C','D','E'].map(k=>`<div class="field"><label>Opción ${k}</label><textarea id="e${k}" class="textarea-md">${esc(opts[k]||'')}</textarea></div>`).join('')}<div class="field"><label>Respuesta correcta</label><select id="eAnswer">${['','A','B','C','D','E'].map(k=>`<option ${q.correct_answer===k?'selected':''}>${k}</option>`).join('')}</select></div></div>
    <div class="field" style="margin-top:12px"><label>Explicación</label><textarea id="eExplanation" class="textarea-lg">${esc(q.explanation||'')}</textarea></div><div class="field" style="margin-top:12px"><label>Dato clave</label><textarea id="eTip" class="textarea-md">${esc(q.galactic_tip||'')}</textarea></div>
    <div class="form-grid" style="margin-top:12px"><div class="field"><label>Imagen</label><input id="eImage" value="${esc(q.image_url||'')}" placeholder="URL o ruta" /><div class="inline" style="margin-top:8px"><input id="eImageFile" type="file" accept="image/*" /><button id="uploadImage" class="btn btn-soft" type="button">Subir a Storage</button></div></div><div class="field"><label>Observaciones internas</label><textarea id="eNotes" class="textarea-md">${esc(q.review_notes||'')}</textarea></div></div>
    <label class="checkbox" style="margin-top:12px"><input id="eRequiresImage" type="checkbox" ${q.requires_image?'checked':''}/> Esta pregunta requiere imagen</label>
    <div class="modal-actions">${state.profile?.role==='admin'?'<button id="deleteQuestion" class="btn btn-danger">Eliminar</button>':''}${state.profile?.role==='admin'||q.status!=='PUBLICADA'?'<button class="btn btn-danger" data-qstatus="ARCHIVADA">Archivar</button><button class="btn" data-qstatus="PENDIENTE">Pendiente</button><button class="btn" data-qstatus="APROBADA">Aprobar</button>':''}${state.profile?.role==='admin'?'<button class="btn btn-primary" data-qstatus="PUBLICADA">Publicar</button>':''}<button id="saveQuestion" class="btn btn-primary">Guardar cambios</button></div></div></div>`;
  document.getElementById('closeModal').onclick=closeModal;document.querySelector('.modal-backdrop').onclick=e=>{if(e.target.classList.contains('modal-backdrop'))closeModal()};
  document.getElementById('uploadImage').onclick=()=>uploadQuestionImage(q);
  const collect=()=>{const options={};['A','B','C','D','E'].forEach(k=>{const v=document.getElementById(`e${k}`).value.trim();if(v)options[k]=v});return {exam_type:document.getElementById('eExam').value,bank_name:document.getElementById('eBank').value.trim(),year:Number(document.getElementById('eYear').value)||null,specialty:document.getElementById('eSpec').value.trim()||'Sin clasificar',topic:document.getElementById('eTopic').value.trim()||'Sin clasificar',subtopic:document.getElementById('eSub').value.trim()||'Sin clasificar',stem:document.getElementById('eStem').value.trim(),options,correct_answer:document.getElementById('eAnswer').value||null,explanation:document.getElementById('eExplanation').value.trim(),galactic_tip:document.getElementById('eTip').value.trim(),explanation_source:'MANUAL',image_url:document.getElementById('eImage').value.trim()||null,requires_image:document.getElementById('eRequiresImage').checked,review_notes:document.getElementById('eNotes').value.trim(),updated_by:state.user.id};};
  const save=async status=>{const payload=collect();if(status)payload.status=status;if(payload.status==='PUBLICADA' || status==='PUBLICADA'){if(!payload.correct_answer||Object.keys(payload.options).length<2||!payload.stem){notify('No se puede publicar: revisa enunciado, opciones y clave.',4500);return;}if(payload.requires_image&&!payload.image_url&&!confirm('La pregunta requiere imagen pero no tiene URL. ¿Publicar de todas formas?'))return;}const {error}=await db().from('questions').update(payload).eq('id',id);if(error)notify(humanError(error));else{notify('Pregunta guardada');closeModal();loadAdminQuestionsTable();}};
  document.getElementById('saveQuestion').onclick=()=>save(null);document.querySelectorAll('[data-qstatus]').forEach(b=>b.onclick=()=>save(b.dataset.qstatus));const del=document.getElementById('deleteQuestion');if(del)del.onclick=()=>deleteQuestion(q);
}
async function deleteQuestion(q){const typed=prompt(`Para eliminar definitivamente ${q.external_id}, escribe su ID exacto:`);if(typed!==q.external_id){notify('Eliminación cancelada');return;}const {error}=await db().from('questions').delete().eq('id',q.id);if(error)notify(humanError(error));else{notify('Pregunta eliminada. El historial asociado no se puede recuperar.');closeModal();loadAdminQuestionsTable();}}
async function uploadQuestionImage(q){
  const input=document.getElementById('eImageFile');const file=input?.files?.[0];if(!file){notify('Selecciona una imagen');return;}
  setBusy(true);
  try{
    const ext=(file.name.split('.').pop()||'png').replace(/[^A-Za-z0-9]/g,'').toLowerCase();
    const safe=(q.external_id||q.id).replace(/[^A-Za-z0-9_-]/g,'_');
    const path=`questions/${safe}-${Date.now()}.${ext}`;
    const {error}=await db().storage.from('question-assets').upload(path,file,{upsert:false,contentType:file.type||undefined});if(error)throw error;
    const {data}=db().storage.from('question-assets').getPublicUrl(path);
    const url=data?.publicUrl;if(!url)throw new Error('No se pudo obtener la URL pública');
    document.getElementById('eImage').value=url;document.getElementById('eRequiresImage').checked=true;notify('Imagen subida. Guarda la pregunta para aplicar el cambio.');
  }catch(e){notify(humanError(e),5000)}finally{setBusy(false)}
}

function activateModalAccessibility(){const backdrop=modalRoot.querySelector('.modal-backdrop'),modal=modalRoot.querySelector('.modal');if(!backdrop||!modal||modal.dataset.a11y)return;modal.dataset.a11y='1';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.tabIndex=-1;closeModal.returnFocus=document.activeElement;setTimeout(()=>modal.focus(),0);backdrop.addEventListener('click',e=>{if(e.target===backdrop)closeModal();});modalRoot.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=closeModal);}
function openModal(content){modalRoot.innerHTML=`<div class="modal-backdrop">${content}</div>`;activateModalAccessibility();}
function closeModal(){modalRoot.innerHTML='';if(closeModal.returnFocus?.focus)closeModal.returnFocus.focus();closeModal.returnFocus=null;}

function showReportModal(q){
  modalRoot.innerHTML=`<div class="modal-backdrop"><div class="modal" style="max-width:580px"><h2>Reportar pregunta</h2><p class="muted">${esc(q.external_id)}</p><div class="field"><label>Motivo</label><select id="reportReason"><option>Clave incorrecta</option><option>Pregunta desactualizada</option><option>Error de redacción/OCR</option><option>Imagen faltante</option><option>Otro</option></select></div><div class="field" style="margin-top:12px"><label>Comentario</label><textarea id="reportComment" class="textarea-md"></textarea></div><div class="modal-actions"><button class="btn" id="cancelReport">Cancelar</button><button class="btn btn-primary" id="sendReport">Enviar reporte</button></div></div></div>`;
  document.getElementById('cancelReport').onclick=closeModal;document.getElementById('sendReport').onclick=async()=>{const {error}=await db().from('question_reports').insert({user_id:state.user.id,question_id:q.id,reason:document.getElementById('reportReason').value,comment:document.getElementById('reportComment').value.trim()});notify(error?humanError(error):'Reporte enviado');if(!error)closeModal();};
}
function showAccountModal(){
  if(!state.user)return;
  modalRoot.innerHTML=`<div class="modal-backdrop"><div class="modal" style="max-width:520px"><div class="space-between"><div><div class="kicker">CUENTA</div><h2>${esc(state.profile?.full_name||'Usuario')}</h2></div><button id="closeAccount" class="btn">Cerrar</button></div><p>${esc(state.user.email)}</p><div class="pill-row"><span class="tag">Rol: ${esc(state.profile?.role)}</span><span class="tag">Plan: ${esc(state.profile?.plan)}</span><span class="tag">Objetivo: ${esc(state.profile?.target_exam)}</span></div><div class="divider"></div><button id="signOut" class="btn btn-danger">Cerrar sesión</button></div></div>`;
  document.getElementById('closeAccount').onclick=closeModal;document.getElementById('signOut').onclick=async()=>{if(state.active&&!state.active.finished&&!confirm('Tienes una sesión guardada. ¿Cerrar sesión de todas formas?'))return;await db().auth.signOut();closeModal();};
}

document.addEventListener('click',e=>{const b=e.target.closest('[data-go]');if(b){e.preventDefault();go(b.dataset.go)}});
init().catch(e=>{console.error('BANQO init error',e);setShell(false);app.innerHTML=`<section class="auth-shell"><div class="card auth-card"><div class="auth-logo"><span class="brand-mark">B</span><div><div class="kicker">BANQO PERÚ</div><h2>No se pudo iniciar BANQO</h2></div></div><p class="danger-text">${esc(humanError(e))}</p><p class="muted small">Actualiza con Ctrl + F5. Si continúa, revisa la conexión configurada.</p><button class="btn btn-primary" onclick="location.reload()">Reintentar</button></div></section>`;});
