const ALLOWED_ANSWERS = ['A','B','C','D','E'];

export function normalizeHeader(value=''){
  return String(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toUpperCase().trim().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
}

function val(row, ...names){
  const map = Object.fromEntries(Object.entries(row).map(([k,v]) => [normalizeHeader(k), v]));
  for (const n of names){
    const key = normalizeHeader(n);
    if (map[key] !== undefined && map[key] !== null) return map[key];
  }
  return '';
}

function cleanText(v){
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g,' ').trim();
}

function cleanAnswer(v){
  const m = cleanText(v).toUpperCase().match(/[A-E]/);
  return m ? m[0] : null;
}

function makeId(prefix, n){
  const p = cleanText(prefix || 'BANQO').replace(/[^A-Za-z0-9_-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').toUpperCase();
  return `${p}-${String(n).padStart(3,'0')}`;
}

export async function sha256(text){
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function finalizeQuestion(q, order, meta){
  q.external_id = cleanText(q.external_id) || makeId(meta.prefix, order);
  q.bank_type = meta.bankType || q.bank_type || 'BANCO';
  q.exam_type = meta.examType || q.exam_type || 'RESIDENTADO';
  q.bank_name = meta.bankName || q.bank_name || 'BANQO';
  q.year = Number(meta.year || q.year) || null;
  q.specialty = cleanText(q.specialty) || meta.specialty || 'Sin clasificar';
  q.topic = cleanText(q.topic) || meta.topic || 'Sin clasificar';
  q.subtopic = cleanText(q.subtopic) || meta.subtopic || 'Sin clasificar';
  q.section = cleanText(q.section);
  q.stem = cleanText(q.stem);
  q.options = q.options || {};
  for (const k of Object.keys(q.options)) q.options[k] = cleanText(q.options[k]);
  q.correct_answer = cleanAnswer(q.correct_answer);
  q.explanation = cleanText(q.explanation);
  q.galactic_tip = cleanText(q.galactic_tip);
  q.source_reference = cleanText(q.source_reference) || `${q.bank_name} - Pregunta ${order}`;
  q.source_page = Number(q.source_page) || null;
  q.requires_image = Boolean(q.requires_image);
  q.image_url = cleanText(q.image_url) || null;
  q.status = 'PENDIENTE';
  q.review_notes = cleanText(q.review_notes);
  q.source_uid = cleanText(q.source_uid) || `${q.bank_name}:${order}`;
  q.version = Number(q.version) || 1;
  q.source_hash = await sha256(JSON.stringify({stem:q.stem,options:q.options,answer:q.correct_answer}));
  q._order = order;
  return q;
}

export async function parseSpreadsheet(file, meta){
  const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type:'array' });
  const preferred = wb.SheetNames.find(n => normalizeHeader(n).includes('CARGA_PREGUNTAS')) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[preferred], { defval:'' });
  const out = [];
  for (let i=0; i<rows.length; i++){
    const r = rows[i];
    const options = {};
    for (const k of ALLOWED_ANSWERS){
      const ov = cleanText(val(r, `OPCION_${k}`, `OPCIÓN_${k}`, `ALTERNATIVA_${k}`, k));
      if (ov) options[k] = ov;
    }
    const q = {
      external_id: cleanText(val(r,'ID_EXTERNO','ID','CODIGO','CÓDIGO')),
      bank_type: cleanText(val(r,'TIPO_BANCO','BANK_TYPE')),
      exam_type: cleanText(val(r,'EXAMEN','EXAM_TYPE','BANCO_ORIGEN')),
      bank_name: cleanText(val(r,'NOMBRE_BANCO','BANCO','FUENTE')),
      year: val(r,'AÑO','ANO','YEAR'),
      specialty: cleanText(val(r,'ESPECIALIDAD')),
      topic: cleanText(val(r,'TEMA')),
      subtopic: cleanText(val(r,'SUBTEMA')),
      section: cleanText(val(r,'APARTADO','SECCION','SECCIÓN')),
      stem: cleanText(val(r,'ENUNCIADO','PREGUNTA','STEM')),
      options,
      correct_answer: cleanAnswer(val(r,'RESPUESTA_CORRECTA','RESPUESTA','CLAVE','ANSWER')),
      explanation: cleanText(val(r,'COMENTARIO_ORIGINAL','EXPLICACION','EXPLICACIÓN','COMENTARIO')),
      galactic_tip: cleanText(val(r,'DATITO_GALACTICO','DATO_GALACTICO')),
      source_reference: cleanText(val(r,'FUENTE_REFERENCIA','FUENTE')),
      source_page: val(r,'PAGINA','PÁGINA','SOURCE_PAGE'),
      requires_image: /^(SI|SÍ|TRUE|1|YES)$/i.test(cleanText(val(r,'REQUIERE_IMAGEN','TIENE_IMAGEN'))),
      image_url: cleanText(val(r,'ARCHIVO_IMAGEN','IMAGEN_URL','IMAGE_URL')),
      review_notes: cleanText(val(r,'OBSERVACIONES_INTERNAS','OBSERVACIONES')),
      source_uid: cleanText(val(r,'SOURCE_UID')),
      version: val(r,'VERSION') || 1
    };
    out.push(await finalizeQuestion(q, i+1, meta));
  }
  return out.filter(q => q.stem || Object.keys(q.options).length);
}

export async function parseJson(file, meta){
  const raw = JSON.parse(await file.text());
  const arr = Array.isArray(raw) ? raw : (raw.questions || raw.preguntas || []);
  const out=[];
  for (let i=0;i<arr.length;i++){
    const src=arr[i] || {};
    const q={
      external_id: src.external_id || src.id || '',
      bank_type: src.bank_type || src.bankType || '',
      exam_type: src.exam_type || src.examType || src.bank || '',
      bank_name: src.bank_name || src.bankName || src.source || '',
      year: src.year,
      specialty: src.specialty || src.especialidad,
      topic: src.topic || src.tema,
      subtopic: src.subtopic || src.subtema,
      section: src.section || src.apartado,
      stem: src.stem || src.enunciado || src.question || '',
      options: src.options || {
        A:src.opcion_a||src.opcionA, B:src.opcion_b||src.opcionB, C:src.opcion_c||src.opcionC,
        D:src.opcion_d||src.opcionD, E:src.opcion_e||src.opcionE
      },
      correct_answer: src.correct_answer || src.answer || src.respuesta_correcta,
      explanation: src.explanation || src.comentario_original || src.comentario || '',
      galactic_tip: src.galactic_tip || src.datito_galactico || '',
      source_reference: src.source_reference || src.fuente_referencia || '',
      source_page: src.source_page,
      requires_image: src.requires_image || src.requiere_imagen,
      image_url: src.image_url || src.archivo_imagen || null,
      review_notes: src.review_notes || src.observaciones_internas || '',
      source_uid: src.source_uid,
      version: src.version || 1
    };
    Object.keys(q.options).forEach(k=>{ if(!q.options[k]) delete q.options[k]; });
    out.push(await finalizeQuestion(q,i+1,meta));
  }
  return out;
}

// ---------- PDF import: layout-aware parser + highlighted key detection ----------
let ocrWorkerPromise = null;

async function ensurePdfJs(){
  if(window.pdfjsLib) return window.pdfjsLib;
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  window.pdfjsLib=pdfjs;
  return pdfjs;
}

function textItemGeom(it, viewport, util){
  if(!it?.str || !String(it.str).trim()) return null;
  const tx=util.transform(viewport.transform,it.transform);
  const x=tx[4], baseline=tx[5];
  const h=Math.max(7,Math.hypot(tx[2]||0,tx[3]||0) || Math.abs(tx[3]) || it.height*viewport.scale || 9);
  const w=Math.max(2,(it.width||Math.max(1,String(it.str).length*4.5))*viewport.scale);
  return {text:String(it.str),x,x2:x+w,baseline,h,y0:baseline-h*1.15,y1:baseline+h*.30};
}

function detectTwoColumns(items, viewport){
  const mid=viewport.width/2, gutter=viewport.width*.018;
  let left=0,right=0,cross=0,total=0;
  for(const g of items){
    const weight=Math.max(1,g.text.trim().length); total+=weight;
    if(g.x2 < mid-gutter) left+=weight;
    else if(g.x > mid+gutter) right+=weight;
    else if(g.x < mid && g.x2 > mid) cross+=weight;
  }
  // Recalculate ambiguous short items by center.
  for(const g of items){
    const weight=Math.max(1,g.text.trim().length);
    if(!(g.x2 < mid-gutter) && !(g.x > mid+gutter) && !(g.x < mid && g.x2 > mid)){
      if((g.x+g.x2)/2<mid) left+=weight; else right+=weight;
    }
  }
  if(!total) return false;
  return left/total>.20 && right/total>.20 && cross/total<.13;
}

function groupGeomsToLines(geoms, bounds){
  const [left,right]=bounds;
  const selected=geoms.filter(g=>{
    const cx=(g.x+g.x2)/2;
    return cx>=left && cx<right;
  }).sort((a,b)=>a.baseline-b.baseline || a.x-b.x);
  const lines=[];
  for(const g of selected){
    const tol=Math.max(2.2,g.h*.35);
    let line=lines.find(l=>Math.abs(l.baseline-g.baseline)<=Math.max(tol,l.h*.35));
    if(!line){line={baseline:g.baseline,h:g.h,items:[]};lines.push(line);}
    line.items.push(g); line.h=Math.max(line.h,g.h);
  }
  for(const l of lines){
    l.items.sort((a,b)=>a.x-b.x);
    l.text=l.items.map(x=>x.text).join(' ').replace(/\s+/g,' ').trim();
    l.x=Math.min(...l.items.map(x=>x.x));
    l.x2=Math.max(...l.items.map(x=>x.x2));
    l.y0=Math.min(...l.items.map(x=>x.y0));
    l.y1=Math.max(...l.items.map(x=>x.y1));
  }
  return lines.filter(l=>l.text).sort((a,b)=>a.baseline-b.baseline || a.x-b.x);
}

function cleanPdfLines(lines){
  return lines.filter(l=>{
    const t=l.text.trim();
    if(!t) return false;
    if(/^(Evaluación\s+Resultado|Solucionario)$/i.test(t)) return false;
    if(/^Página\s+\d+/i.test(t)) return false;
    return true;
  });
}

function parseQuestionStart(text){
  let m=String(text).match(/^\s*Pregunta\s*(\d{1,3})(?:\s*\/\s*\d{1,3})?\s*[:.\-)]?\s*(.*)$/i);
  if(m){const n=Number(m[1]);return n>=1?{number:n,first:(m[2]||'').trim()}:null;}
  // Deliberadamente exige punto + espacio para no confundir 0.5 mg/dL o 3.2 cm con una pregunta.
  m=String(text).match(/^\s*(\d{1,3})\.\s+(.*)$/);
  if(m){const n=Number(m[1]);return n>=1?{number:n,first:(m[2]||'').trim()}:null;}
  m=String(text).match(/^\s*(\d{1,3})\.\s*$/);
  if(m){const n=Number(m[1]);return n>=1?{number:n,first:''}:null;}
  return null;
}

function parseOptionStart(text){
  const m=String(text).match(/^\s*([A-E])\s*[.)\-:]\s*(.*)$/i);
  return m?{letter:m[1].toUpperCase(),first:(m[2]||'').trim()}:null;
}

function greenSignal(ctx,x0,y0,x1,y1){
  const c=ctx.canvas;
  x0=Math.max(0,Math.floor(x0)); y0=Math.max(0,Math.floor(y0));
  x1=Math.min(c.width,Math.ceil(x1)); y1=Math.min(c.height,Math.ceil(y1));
  if(x1<=x0 || y1<=y0) return 0;
  const data=ctx.getImageData(x0,y0,x1-x0,y1-y0).data;
  let green=0,total=0;
  // 1 muestra cada 2 píxeles aprox. La condición reconoce tanto texto verde intenso
  // como el fondo verde claro de los solucionarios que usa BANQO.
  for(let i=0;i<data.length;i+=8){
    const r=data[i],g=data[i+1],b=data[i+2];
    const vivid=g>105 && g-r>18 && g-b>9;
    const pale=g>205 && g-r>7 && g-b>3;
    if(vivid||pale) green++;
    total++;
  }
  return total?green/total:0;
}

function detectCorrect(optionLines,ctx){
  const ranked=[];
  for(const [letter,lines] of Object.entries(optionLines)){
    let score=0;
    for(const l of lines){
      const width=Math.max(150,Math.min(360,l.x2-l.x+120));
      score=Math.max(score,greenSignal(ctx,l.x-12,l.y0-5,l.x+width,l.y1+6));
    }
    ranked.push({letter,score});
  }
  ranked.sort((a,b)=>b.score-a.score);
  const best=ranked[0]||{letter:null,score:0}, second=ranked[1]?.score||0;
  const enough=best.score>=.006 && (second<.004 || best.score>=second*1.28 || best.score-second>=.006);
  const margin=Math.max(0,best.score-second);
  const confidence=enough?Math.min(1,.45+best.score*2.2+margin*3):Math.min(.49,best.score*2);
  return {answer:enough?best.letter:null,score:best.score,confidence,scores:ranked};
}

function parseQuestionSegments(lines,ctx,pageNo){
  const starts=[];
  lines.forEach((l,i)=>{const q=parseQuestionStart(l.text);if(q)starts.push({i,...q});});
  const out=[];
  for(let s=0;s<starts.length;s++){
    const st=starts[s],end=s+1<starts.length?starts[s+1].i:lines.length;
    const seg=lines.slice(st.i,end).map(x=>({...x}));
    if(!seg.length) continue;
    seg[0].text=st.first;
    const opts=[];
    seg.forEach((l,i)=>{const op=parseOptionStart(l.text);if(op)opts.push({i,...op});});
    if(opts.length<2) continue;
    const stem=seg.slice(0,opts[0].i).map(x=>x.text).filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
    const options={},optionLines={};
    opts.forEach((op,oi)=>{
      const e=oi+1<opts.length?opts[oi+1].i:seg.length;
      const block=seg.slice(op.i,e);
      options[op.letter]=[op.first,...block.slice(1).map(x=>x.text)].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
      optionLines[op.letter]=block;
    });
    const key=detectCorrect(optionLines,ctx);
    out.push({number:st.number,page:pageNo,stem,options,correct_answer:key.answer,_highlightScore:key.score,_keyConfidence:key.confidence});
  }
  return out;
}

function flattenOcrWords(data){
  if(Array.isArray(data?.words) && data.words.length) return data.words;
  const words=[];
  for(const block of data?.blocks||[]) for(const par of block.paragraphs||[]) for(const line of par.lines||[]) for(const word of line.words||[]) words.push(word);
  return words;
}

async function ensureOcrWorker(){
  if(!ocrWorkerPromise){
    ocrWorkerPromise=(async()=>{
      const {createWorker}=await import('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js');
      return await createWorker('spa');
    })();
  }
  return ocrWorkerPromise;
}

async function ocrCanvasGeoms(canvas,onProgress=()=>{}){
  onProgress({stage:'OCR (PDF escaneado)'});
  const worker=await ensureOcrWorker();
  const result=await worker.recognize(canvas);
  const words=flattenOcrWords(result?.data);
  return words.map(w=>{
    const b=w.bbox||{};const text=w.text||w.symbols?.map(s=>s.text).join('')||'';
    const x=Number(b.x0)||0,x2=Number(b.x1)||x+Math.max(4,text.length*6),y0=Number(b.y0)||0,y1=Number(b.y1)||y0+12;
    return {text,x,x2,baseline:y1,h:Math.max(8,y1-y0),y0,y1};
  }).filter(x=>x.text.trim());
}

function getPageColumns(geoms,viewport){
  if(detectTwoColumns(geoms,viewport)) return [[0,viewport.width/2],[viewport.width/2,viewport.width]];
  return [[0,viewport.width]];
}

export async function parseHighlightedAnswerPdf(file,meta,onProgress=()=>{}){
  const pdfjs=await ensurePdfJs();
  const data=new Uint8Array(await file.arrayBuffer());
  const pdf=await pdfjs.getDocument({data}).promise;
  const found=[];
  const scale=1.80;

  for(let pno=1;pno<=pdf.numPages;pno++){
    onProgress({page:pno,total:pdf.numPages,stage:'Leyendo PDF'});
    const page=await pdf.getPage(pno);
    const viewport=page.getViewport({scale});
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    await page.render({canvasContext:ctx,viewport}).promise;
    const content=await page.getTextContent();
    const util=pdfjs.Util;
    let geoms=(content.items||[]).map(it=>textItemGeom(it,viewport,util)).filter(Boolean);
    const charCount=geoms.reduce((a,g)=>a+g.text.trim().length,0);
    if(charCount<45){
      try{
        onProgress({page:pno,total:pdf.numPages,stage:'OCR de página escaneada'});
        geoms=await ocrCanvasGeoms(canvas,()=>{});
      }catch(err){
        console.warn('OCR no disponible:',err);
      }
    }
    for(const bounds of getPageColumns(geoms,viewport)){
      const lines=cleanPdfLines(groupGeomsToLines(geoms,bounds));
      found.push(...parseQuestionSegments(lines,ctx,pno));
    }
  }

  const uniq=new Map();
  for(const q of found){
    const richness=Object.keys(q.options||{}).length*1000+(q.correct_answer?300:0)+(q.stem?.length||0);
    const old=uniq.get(q.number);
    const oldRich=old?Object.keys(old.options||{}).length*1000+(old.correct_answer?300:0)+(old.stem?.length||0):-1;
    if(!old || richness>oldRich) uniq.set(q.number,q);
  }
  const sorted=[...uniq.values()].filter(x=>x.number>=1).sort((a,b)=>a.number-b.number);
  const out=[];
  for(const r of sorted){
    const needsImage=/(se\s+adjunta|se\s+muestra|siguiente\s+imagen|imagen\s+(?:adjunta|mostrada|siguiente)|seg[uú]n\s+(?:la\s+)?imagen|observe\s+(?:la\s+)?imagen|figura\s+(?:adjunta|siguiente)|fotograf(?:ía|ia)|radiograf(?:ía|ia)|ecg\s+(?:adjunto|siguiente)|ekg\s+(?:adjunto|siguiente)|estudio\s+de\s+heces.*imagen)/i.test(r.stem);
    const conf=Math.round((r._keyConfidence||0)*100);
    const q={
      external_id:makeId(meta.prefix,r.number),stem:r.stem,options:r.options,correct_answer:r.correct_answer,
      source_page:r.page,requires_image:needsImage,image_url:null,specialty:meta.specialty||'Sin clasificar',topic:meta.topic||'Sin clasificar',subtopic:meta.subtopic||'Sin clasificar',section:'',explanation:'',galactic_tip:'',
      source_reference:`${meta.bankName||file.name} - Pregunta ${r.number}`,
      review_notes:`PDF automático · clave ${r.correct_answer?`detectada (${conf}% confianza)`:'NO detectada'}.${needsImage?' Revisar imagen asociada.':''}`,
      _keyConfidence:r._keyConfidence||0
    };
    out.push(await finalizeQuestion(q,r.number,meta));
  }
  return out;
}

export async function parseAnswerKeyPdf(file,meta={},onProgress=()=>{}){
  const pdfjs=await ensurePdfJs();
  const bytes=new Uint8Array(await file.arrayBuffer());
  const pdf=await pdfjs.getDocument({data:bytes}).promise;
  const keyMap=new Map();
  for(let pno=1;pno<=pdf.numPages;pno++){
    onProgress({page:pno,total:pdf.numPages,stage:'Leyendo claves'});
    const page=await pdf.getPage(pno);const viewport=page.getViewport({scale:1.25});
    const content=await page.getTextContent();
    const geoms=(content.items||[]).map(it=>textItemGeom(it,viewport,pdfjs.Util)).filter(Boolean);
    const columns=getPageColumns(geoms,viewport);
    for(const bounds of columns){
      const lines=cleanPdfLines(groupGeomsToLines(geoms,bounds));
      for(const l of lines){
        let m=l.text.match(/^\s*(\d{1,3})\s*[.)\-:]\s*([A-E])(?:\s|$)/i);
        if(!m) m=l.text.match(/^\s*(\d{1,3})\s+([A-E])\s*$/i);
        if(m){const n=Number(m[1]);if(n>=1)keyMap.set(n,m[2].toUpperCase());}
      }
    }
  }
  if(keyMap.size>=2) return keyMap;
  // Si el solucionario contiene las preguntas completas con respuesta verde, usamos el parser visual.
  const tempMeta={...meta,prefix:meta.prefix||'KEY',bankName:meta.bankName||file.name};
  const parsed=await parseHighlightedAnswerPdf(file,tempMeta,onProgress);
  for(const q of parsed){if(q.correct_answer) keyMap.set(q._order,q.correct_answer);}
  return keyMap;
}

export async function mergeAnswerKey(questions,keyMap,keyName='solucionario'){
  let matched=0;
  for(const q of questions){
    const ans=keyMap.get(q._order);
    if(!ans) continue;
    q.correct_answer=ans;matched++;
    q.review_notes=[q.review_notes,`Clave cruzada con ${keyName}.`].filter(Boolean).join(' ');
    q.source_hash=await sha256(JSON.stringify({stem:q.stem,options:q.options,answer:q.correct_answer}));
  }
  return {questions,matched,totalKeys:keyMap.size};
}

export function validateQuestions(questions){
  const seen=new Set();
  const rows=[];
  const summary={total:questions.length,valid:0,errors:0,warnings:0,missingAnswer:0,needsImage:0,duplicates:0,lowConfidence:0,missingNumbers:0,missingNumberList:[]};
  for(const q of questions){
    const errors=[],warnings=[];
    if(!q.external_id) errors.push('Sin ID');
    if(seen.has(q.external_id)){errors.push('ID duplicado');summary.duplicates++;}else seen.add(q.external_id);
    if(!q.stem||q.stem.length<5) errors.push('Enunciado vacío o demasiado corto');
    const optionKeys=Object.keys(q.options||{}).filter(k=>ALLOWED_ANSWERS.includes(k)&&cleanText(q.options[k]));
    if(optionKeys.length<2) errors.push('Menos de 2 alternativas');
    if(!q.correct_answer){errors.push('Sin clave detectada');summary.missingAnswer++;}
    else if(!optionKeys.includes(q.correct_answer)) errors.push('La clave no existe entre las alternativas');
    if(q._keyConfidence!==undefined && q.correct_answer && q._keyConfidence<.58){warnings.push('Clave con baja confianza: revisar');summary.lowConfidence++;}
    if(q.specialty==='Sin clasificar') warnings.push('Sin clasificación');
    if(q.requires_image&&!q.image_url){warnings.push('Imagen pendiente');summary.needsImage++;}
    if(!q.explanation) warnings.push('Sin explicación');
    if(errors.length)summary.errors++;else summary.valid++;
    if(warnings.length)summary.warnings++;
    rows.push({question:q,errors,warnings,ok:errors.length===0});
  }
  const nums=[...new Set(questions.map(q=>Number(q._order)).filter(n=>Number.isInteger(n)&&n>=1&&n<=1000))].sort((a,b)=>a-b);
  if(nums.length>=2 && nums[0]===1){
    const set=new Set(nums), max=nums[nums.length-1];
    const missing=[];for(let n=1;n<=max;n++)if(!set.has(n))missing.push(n);
    summary.missingNumbers=missing.length;summary.missingNumberList=missing.slice(0,100);
  }
  return {summary,rows};
}

export async function parseFile(file,meta,onProgress){
  const name=file.name.toLowerCase();
  if(name.endsWith('.xlsx')||name.endsWith('.xls')||name.endsWith('.csv'))return parseSpreadsheet(file,meta);
  if(name.endsWith('.json'))return parseJson(file,meta);
  if(name.endsWith('.pdf'))return parseHighlightedAnswerPdf(file,meta,onProgress);
  throw new Error('Formato no compatible. Usa XLSX, CSV, JSON o PDF.');
}
