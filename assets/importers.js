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

function groupTextItems(items, viewport){
  const lines=[];
  const util = window.pdfjsLib?.Util;
  for (const it of items){
    if (!it.str || !it.str.trim()) continue;
    const tx = util ? util.transform(viewport.transform, it.transform) : it.transform;
    const x = tx[4], y = tx[5];
    const h = Math.max(8, Math.abs(tx[3] || it.height || 10));
    const w = Math.max(2, (it.width || it.str.length*5) * viewport.scale);
    let line = lines.find(l => Math.abs(l.y-y) <= Math.max(2.5, h*0.25) && Math.abs(l.x-x) < viewport.width/2);
    if (!line){ line={x,y,h,items:[]}; lines.push(line); }
    line.items.push({text:it.str,x,y,w,h});
    line.x=Math.min(line.x,x); line.h=Math.max(line.h,h);
  }
  for (const l of lines){
    l.items.sort((a,b)=>a.x-b.x);
    l.text=l.items.map(x=>x.text).join(' ').replace(/\s+/g,' ').trim();
    l.x=Math.min(...l.items.map(x=>x.x));
    l.x2=Math.max(...l.items.map(x=>x.x+x.w));
    l.y=Math.min(...l.items.map(x=>x.y));
    l.y2=l.y+l.h;
  }
  return lines.filter(l=>l.text);
}

function greenRatio(ctx, x0, y0, x1, y1){
  const canvas=ctx.canvas;
  x0=Math.max(0,Math.floor(x0)); y0=Math.max(0,Math.floor(y0));
  x1=Math.min(canvas.width,Math.ceil(x1)); y1=Math.min(canvas.height,Math.ceil(y1));
  if (x1<=x0 || y1<=y0) return 0;
  const im=ctx.getImageData(x0,y0,x1-x0,y1-y0).data;
  let green=0,total=0;
  const step=16; // sample every 4 pixels
  for(let i=0;i<im.length;i+=step){
    const r=im[i],g=im[i+1],b=im[i+2];
    if(g>235 && r>190 && b>205 && g-r>12) green++;
    total++;
  }
  return total ? green/total : 0;
}

function detectCorrect(optionLines, ctx){
  let best=null,bestScore=0;
  for (const [letter, lines] of Object.entries(optionLines)){
    let score=0;
    for (const l of lines){
      score=Math.max(score,greenRatio(ctx,Math.max(0,l.x-8),Math.max(0,l.y-l.h-4),Math.min(ctx.canvas.width,l.x2+80),Math.min(ctx.canvas.height,l.y2+6)));
    }
    if(score>bestScore){bestScore=score;best=letter;}
  }
  return bestScore>=0.025 ? {answer:best,score:bestScore} : {answer:null,score:bestScore};
}

async function ensurePdfJs(){
  if(window.pdfjsLib) return window.pdfjsLib;
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  // expose Util for groupTextItems
  window.pdfjsLib=pdfjs;
  return pdfjs;
}

export async function parseHighlightedAnswerPdf(file, meta, onProgress=()=>{}){
  const pdfjs = await ensurePdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({data}).promise;
  const found=[];

  for(let pno=1;pno<=pdf.numPages;pno++){
    onProgress({page:pno,total:pdf.numPages,stage:'Leyendo PDF'});
    const page=await pdf.getPage(pno);
    const viewport=page.getViewport({scale:1.55});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    await page.render({canvasContext:ctx,viewport}).promise;
    const content=await page.getTextContent();
    let lines=groupTextItems(content.items,viewport)
      .filter(l=>!/^Evaluación Resultado$/i.test(l.text) && !/^Solucionario$/i.test(l.text));

    for(const column of [0,1]){
      const left=column===0?0:viewport.width/2;
      const right=column===0?viewport.width/2:viewport.width;
      const col=lines.filter(l=>((l.x+l.x2)/2)>=left && ((l.x+l.x2)/2)<right).sort((a,b)=>a.y-b.y || a.x-b.x);
      const starts=[];
      col.forEach((l,i)=>{
        const m=l.text.match(/^\s*(\d+)\.\s+(.+)/);
        if(m) starts.push({i,n:Number(m[1]),first:m[2]});
      });

      for(let s=0;s<starts.length;s++){
        const st=starts[s], end=s+1<starts.length?starts[s+1].i:col.length;
        const seg=col.slice(st.i,end).map(x=>({...x}));
        if(!seg.length) continue;
        seg[0].text=st.first;
        const opts=[];
        seg.forEach((l,i)=>{
          const m=l.text.match(/^\s*([A-E])[\.\)]\s+(.+)/);
          if(m) opts.push({i,letter:m[1],first:m[2]});
        });
        if(opts.length<2) continue;
        const stem=seg.slice(0,opts[0].i).map(x=>x.text).join(' ').replace(/\s+/g,' ').trim();
        const options={}, optionLines={};
        opts.forEach((op,oi)=>{
          const e=oi+1<opts.length?opts[oi+1].i:seg.length;
          const chunk=seg.slice(op.i,e);
          options[op.letter]=[op.first,...chunk.slice(1).map(x=>x.text)].join(' ').replace(/\s+/g,' ').trim();
          optionLines[op.letter]=chunk;
        });
        const key=detectCorrect(optionLines,ctx);
        found.push({number:st.n,page:pno,stem,options,correct_answer:key.answer,_highlightScore:key.score});
      }
    }
  }

  const uniq=new Map();
  for(const q of found){
    if(!uniq.has(q.number) || Object.keys(q.options).length>Object.keys(uniq.get(q.number).options).length) uniq.set(q.number,q);
  }
  const sorted=[...uniq.values()].sort((a,b)=>a.number-b.number);
  const out=[];
  for(let i=0;i<sorted.length;i++){
    const r=sorted[i];
    const needsImage=/(se adjunta|siguiente imagen|imagen (?:adjunta|mostrada|siguiente)|figura (?:adjunta|siguiente)|fotograf(?:ía|ia) (?:adjunta|siguiente)|radiograf(?:ía|ia) adjunta|ecg adjunto|ekg adjunto)/i.test(r.stem);
    const q={
      external_id: makeId(meta.prefix,r.number),
      stem:r.stem,
      options:r.options,
      correct_answer:r.correct_answer,
      source_page:r.page,
      requires_image:needsImage,
      image_url:null,
      specialty:meta.specialty || 'Sin clasificar',
      topic:meta.topic || 'Sin clasificar',
      subtopic:meta.subtopic || 'Sin clasificar',
      section:'',
      explanation:'',
      galactic_tip:'',
      source_reference:`${meta.bankName || file.name} - Pregunta ${r.number}`,
      review_notes:`PDF resaltado · confianza de clave ${(r._highlightScore*100).toFixed(1)}%. ${needsImage?'Revisar imagen asociada.':''}`
    };
    out.push(await finalizeQuestion(q,r.number,meta));
  }
  return out;
}

export function validateQuestions(questions){
  const seen=new Set();
  const rows=[];
  const summary={total:questions.length,valid:0,errors:0,warnings:0,missingAnswer:0,needsImage:0,duplicates:0};
  for(const q of questions){
    const errors=[],warnings=[];
    if(!q.external_id) errors.push('Sin ID');
    if(seen.has(q.external_id)){errors.push('ID duplicado');summary.duplicates++;} else seen.add(q.external_id);
    if(!q.stem || q.stem.length<5) errors.push('Enunciado vacío o demasiado corto');
    const optionKeys=Object.keys(q.options||{}).filter(k=>ALLOWED_ANSWERS.includes(k) && cleanText(q.options[k]));
    if(optionKeys.length<2) errors.push('Menos de 2 alternativas');
    if(!q.correct_answer){errors.push('Sin clave detectada');summary.missingAnswer++;}
    else if(!optionKeys.includes(q.correct_answer)) errors.push('La clave no existe entre las alternativas');
    if(q.specialty==='Sin clasificar') warnings.push('Sin clasificación');
    if(q.requires_image && !q.image_url){warnings.push('Imagen pendiente');summary.needsImage++;}
    if(!q.explanation) warnings.push('Sin explicación');
    if(errors.length){summary.errors++;}
    else summary.valid++;
    if(warnings.length) summary.warnings++;
    rows.push({question:q,errors,warnings,ok:errors.length===0});
  }
  return {summary,rows};
}

export async function parseFile(file, meta, onProgress){
  const name=file.name.toLowerCase();
  if(name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) return parseSpreadsheet(file,meta);
  if(name.endsWith('.json')) return parseJson(file,meta);
  if(name.endsWith('.pdf')) return parseHighlightedAnswerPdf(file,meta,onProgress);
  throw new Error('Formato no compatible. Usa XLSX, CSV, JSON o PDF de solucionario con respuesta resaltada.');
}
