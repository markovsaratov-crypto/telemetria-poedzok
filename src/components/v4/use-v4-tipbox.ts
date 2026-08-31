// src/components/v4/use-v4-tipbox.ts — плавающий тултип (тап mobile, hover desktop).
// Единый .v4-tipbox в body, позиционируется с клампом к вьюпорту.
// bindTips() вызывать после каждого динамического рендера.

"use client";

import * as React from "react";

let tipEl: HTMLDivElement | null = null;
let tipOwner: Element | null = null;

function ensureTipEl(): HTMLDivElement {
  if (tipEl && document.body.contains(tipEl)) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "v4-tipbox";
  document.body.appendChild(tipEl);
  return tipEl;
}

function showTip(target: Element) {
  const raw = target.getAttribute("data-tip");
  if (!raw) return;
  const lines = raw.split("|");
  const html = lines
    .map((l, i) => `<span class="t-line">${i === 0 ? `<b>${l}</b>` : l}</span>`)
    .join("");
  const el = ensureTipEl();
  el.innerHTML = html;
  el.style.display = "block";
  tipOwner = target;
  const r = target.getBoundingClientRect();
  const vw = window.innerWidth;
  const tw = Math.min(270, vw - 24);
  el.style.maxWidth = tw + "px";
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(10, Math.min(left, vw - tw - 10));
  el.style.left = left + "px";
  const th = el.offsetHeight;
  const above = r.top > th + 18;
  el.style.top = (above ? r.top + window.scrollY - th - 10 : r.bottom + window.scrollY + 10) + "px";
}

function hideTip() {
  const el = ensureTipEl();
  el.style.display = "none";
  tipOwner = null;
}

export function bindTips(root: ParentNode = document) {
  const els = Array.from(root.querySelectorAll<HTMLElement>("[data-tip]"));
  for (const el of els) {
    if ((el as any).__v4TipBound) continue;
    (el as any).__v4TipBound = true;
    el.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      if (tipOwner === el) {
        hideTip();
        return;
      }
      showTip(el);
    });
    if (window.matchMedia && window.matchMedia("(hover:hover)").matches) {
      el.addEventListener("mouseenter", () => showTip(el));
      el.addEventListener("mouseleave", hideTip);
    }
    // AUDIT B-18: доступность с клавиатуры — элементы с data-tip становятся
    // фокусируемыми (tabindex=0), тултип показывается на focus, скрывается на blur,
    // Enter/Space переключают (для plain-span; кнопки и так кликабельны).
    if (!el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "0");
      el.setAttribute("role", el.getAttribute("role") || "tooltip-trigger");
    }
    el.addEventListener("focus", () => showTip(el));
    el.addEventListener("blur", hideTip);
    el.addEventListener("keydown", (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " ") {
        ke.preventDefault();
        if (tipOwner === el) hideTip();
        else showTip(el);
      }
    });
  }
}

let installed = false;

export function useV4Tipbox() {
  React.useEffect(() => {
    if (installed) return;
    installed = true;
    const el = ensureTipEl();
    el.style.display = "none";
    const onDocClick = (e: Event) => {
      if (tipOwner && !tipOwner.contains(e.target as Node)) hideTip();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideTip();
    };
    const onScroll = () => hideTip();
    const onResize = () => hideTip();
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      installed = false;
    };
  }, []);
}
