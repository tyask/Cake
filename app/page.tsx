export default function Home() {
  return (
    <main>
      <section className="card">
        <span className="badge">Next.js × Vercel</span>
        <h1>
          Hello,
          <br />
          Next.js!
        </h1>
        <p>
          サンプルアプリが正常に動作しています。
          <br />
          ここから、あなたのアイデアを形にしていきましょう。
        </p>
        <a
          className="button"
          href="https://nextjs.org/docs"
          target="_blank"
          rel="noreferrer"
        >
          Next.js のドキュメントを見る
          <span aria-hidden="true">↗</span>
        </a>
      </section>
      <p className="footer">Built with Next.js</p>
    </main>
  );
}
