import { LoginScreen } from "@/components/login-screen";
import { Dashboard } from "@/components/dashboard";
import { getCurrentUser } from "@/lib/current-user";
import { isTestAuthEnabled } from "@/lib/auth-mode";
import { getBootstrap } from "@/lib/repository";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ workspaceId?: string; error?: string }> }) {
  const { workspaceId, error } = await searchParams;
  const user = await getCurrentUser();
  const testAuth = isTestAuthEnabled();
  if (!user) return <LoginScreen testAuth={testAuth} error={error} />;

  if (!process.env.DATABASE_URL) {
    return (
      <main className="setup-page">
        <section className="setup-card">
          <span className="brand-icon">C</span>
          <p className="kicker">SETUP REQUIRED</p>
          <h1>データベースを接続してください</h1>
          <p><code>.env.example</code>を参考にNeonの接続情報と<code>AUTH_SECRET</code>を設定し、<code>npm run db:setup</code>を実行してください。</p>
        </section>
      </main>
    );
  }

  const initialData = await getBootstrap(user, workspaceId);
  return <Dashboard initialData={initialData} testAuth={testAuth} />;
}
