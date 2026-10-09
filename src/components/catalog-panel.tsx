"use client";
import {useMemo,useState, type RefObject} from 'react';

export type CatalogItem={key:string;url:string;size:number;lastModified:string|null;nuevo?:boolean;firstSeenAt?:string|null;brands?:string[];stock?:number|null};
export function useCatalogView(items:CatalogItem[],seen:number){
  const [search,setSearch]=useState(''),[brand,setBrand]=useState(''),[image,setImage]=useState('all'),[stock,setStock]=useState('all'),[onlyNew,setOnlyNew]=useState(false),[order,setOrder]=useState('code');
  const brands=useMemo(()=>[...new Set(items.flatMap(p=>p.brands??[]))].sort((a,b)=>a.localeCompare(b)),[items]);
  const indices=useMemo(()=>items.map((item,index)=>({item,index})).filter(({item:p})=>p.key.toUpperCase().includes(search.trim().toUpperCase())&&(!brand||(p.brands??[]).includes(brand))&&(image==='all'||(image==='missing'?p.nuevo:!p.nuevo))&&(stock==='all'||(p.stock!==undefined&&p.stock!==null&&(stock==='available'?p.stock>0:p.stock===0)))&&(!onlyNew||!!(p.firstSeenAt&&Date.parse(p.firstSeenAt)>seen))).sort((a,b)=>order==='stock'?(b.item.stock??-1)-(a.item.stock??-1)||a.item.key.localeCompare(b.item.key):order==='recent'?Date.parse(b.item.lastModified??b.item.firstSeenAt??'1970-01-01')-Date.parse(a.item.lastModified??a.item.firstSeenAt??'1970-01-01')||a.item.key.localeCompare(b.item.key):a.item.key.localeCompare(b.item.key)).map(p=>p.index),[items,search,brand,image,stock,onlyNew,order,seen]);
  const clear=()=>{setSearch('');setBrand('');setImage('all');setStock('all');setOnlyNew(false);};
  return {search,setSearch,brand,setBrand,image,setImage,stock,setStock,onlyNew,setOnlyNew,order,setOrder,brands,indices,clear,active:!!(search||brand||image!=='all'||stock!=='all'||onlyNew)};
}
type Props={items:CatalogItem[];view:ReturnType<typeof useCatalogView>;selected:number;select:(index:number)=>void;seen:number;markSeen:()=>void;loading:boolean;source:string;updatedAt?:string;warning:string;versions:Record<string,number>;listRef:RefObject<HTMLDivElement|null>};
export function CatalogToolbar({items,view:v,seen,markSeen,loading,source,updatedAt,warning}:Pick<Props,"items"|"view"|"seen"|"markSeen"|"loading"|"source"|"updatedAt"|"warning">){
  const newCount=items.filter(p=>p.firstSeenAt&&Date.parse(p.firstSeenAt)>seen).length;
  const hasStock=items.some(p=>p.stock!==undefined&&p.stock!==null);
  return <header className="catalog-toolbar">
    <div className="catalog-heading"><h1>Imágenes de productos</h1><span className="catalog-source"><span className={`status-dot ${warning?'warning':''}`} />{source==='erp'?'ERP':'Cloudflare'}{updatedAt&&<span>{new Date(updatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>}</span></div>
    <div className="catalog-summary">{[{id:'all',label:'Todos',count:items.length},{id:'ready',label:'Con imagen',count:items.filter(p=>!p.nuevo).length},{id:'missing',label:'Sin imagen',count:items.filter(p=>p.nuevo).length}].map(t=><button key={t.id} className={`summary-tile ${v.image===t.id?'active':''}`} aria-pressed={v.image===t.id} onClick={()=>v.setImage(t.id)}><strong>{loading?'—':t.count.toLocaleString()}</strong><span>{t.label}</span></button>)}</div>
    <div className="catalog-filters">
      <div className="filter-search"><label className="field-label" htmlFor="catalog-search">Código universal</label>
      <div className="search-field"><span aria-hidden="true">⌕</span><input id="catalog-search" placeholder="Buscar código…" value={v.search} onChange={e=>v.setSearch(e.target.value)} />{v.search&&<button aria-label="Borrar búsqueda" onClick={()=>v.setSearch('')}>×</button>}</div>
      </div><div className="filter-brand"><label className="field-label" htmlFor="catalog-brand">Marca</label>
      <select id="catalog-brand" value={v.brand} onChange={e=>v.setBrand(e.target.value)} disabled={!v.brands.length}><option value="">Todas las marcas</option>{v.brands.map(b=><option key={b}>{b}</option>)}</select>
      </div><div className="filter-columns"><label>Stock<select aria-label="Stock" disabled={!hasStock} value={v.stock} onChange={e=>v.setStock(e.target.value)}><option value="all">Todo el stock</option><option value="available">Con stock</option><option value="empty">Sin stock</option></select></label><label>Ordenar<select aria-label="Ordenar códigos" value={v.order} onChange={e=>v.setOrder(e.target.value)}><option value="code">Código A–Z</option><option value="recent">Más recientes</option><option value="stock">Mayor stock</option></select></label></div>
      {source==='erp'&&<label className="new-filter"><input type="checkbox" checked={v.onlyNew} onChange={e=>v.setOnlyNew(e.target.checked)} />Nuevos del ERP<span>{newCount}</span></label>}
      {source==='erp'&&!hasStock&&!loading&&<p className="catalog-note">Actualiza el sincronizador para consultar marca y stock.</p>}
      {warning&&<p role="status" className="catalog-warning">{warning}</p>}
      {newCount>0&&<div role="status" className="new-notice"><strong>{newCount} {newCount===1?'código nuevo':'códigos nuevos'}</strong><div><button onClick={()=>{v.clear();v.setOnlyNew(true);}}>Ver nuevos</button><button onClick={()=>{markSeen();v.setOnlyNew(false);}}>Marcar vistos</button></div></div>}
      {v.active&&<button className="clear-filters" onClick={v.clear}>Limpiar filtros</button>}
    </div>
  </header>;
}

export function CatalogPanel({items,view:v,selected,select,seen,loading,versions,listRef}:Pick<Props,"items"|"view"|"selected"|"select"|"seen"|"loading"|"versions"|"listRef">){
  return <aside className="catalog-sidebar" aria-label="Productos">
    <div className="results-heading"><span>{v.indices.length.toLocaleString()} códigos</span></div>
    <div ref={listRef} className="catalog-results">
      {loading&&<p className="empty-results">Cargando catálogo…</p>}
      {!loading&&!v.indices.length&&<div className="empty-results"><strong>No hay coincidencias</strong><p>Prueba otro código o limpia los filtros.</p>{v.active&&<button className="btn" onClick={v.clear}>Limpiar filtros</button>}</div>}
      {v.indices.map(i=>{const p=items[i],isNew=!!(p.firstSeenAt&&Date.parse(p.firstSeenAt)>seen);return <button key={p.key} data-idx={i} onClick={()=>select(i)} aria-pressed={i===selected} className={`product-row ${i===selected?'selected':''}`}>
        <span className="product-preview">{p.nuevo?<span aria-hidden="true">＋</span>:
          // eslint-disable-next-line @next/next/no-img-element
          <img src={versions[p.key]?`${p.url}${p.url.includes('?')?'&':'?'}v=${versions[p.key]}`:p.url} alt="" loading="lazy" />}</span>
        <span className="product-info"><strong>{p.key.slice(0,-4)}</strong><span className="product-tags">{p.nuevo&&<span className="tag missing">Pendiente de imagen</span>}{isNew&&<span className="tag new">Nuevo</span>}</span></span>

      </button>;})}
    </div>

  </aside>;
}
