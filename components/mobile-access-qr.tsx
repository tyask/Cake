"use client";

import { useSyncExternalStore } from "react";
import { QRCodeSVG } from "qrcode.react";

const subscribe = () => () => {};
const getUrl = () => `${window.location.origin}/`;
const getServerUrl = () => "";

export function MobileAccessQr() {
  const url = useSyncExternalStore(subscribe, getUrl, getServerUrl);
  if (!url) return null;

  return (
    <section className="mobile-access-qr" aria-label="スマホで開く">
      <b>スマホで開く</b>
      <a className="mobile-access-qr-code" href={url} aria-label="CakeのURLを開く">
        <QRCodeSVG value={url} size={112} level="M" marginSize={4} title="Cakeをスマホで開くQRコード" />
      </a>
      <p>カメラで読み取るとCakeを開けます</p>
    </section>
  );
}
