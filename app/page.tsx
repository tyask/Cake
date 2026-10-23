import { LoginScreen } from "@/components/login-screen";
import { Dashboard } from "@/components/dashboard";
import { CakeIcon } from "@/components/cake-icon";
import { getCurrentUser } from "@/lib/server/auth/current-user";
import { isTestAuthEnabled } from "@/lib/server/auth/auth-mode";
import { getBootstrap } from "@/lib/server/stores/repository";
import { databaseVariable } from "@/lib/server/database-environment";
import { homeNavigation, type HomeSearchParams } from "@/lib/shared/home-navigation";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<HomeSearchParams> }) {
  const params = await searchParams;
  const { workspaceId, initialTab, redirectTo } = homeNavigation(params);
  const error = typeof params.error === "string" ? params.error : undefined;
  const user = await getCurrentUser();
  const testAuth = isTestAuthEnabled();
  if (!user) return <LoginScreen testAuth={testAuth} error={error} redirectTo={redirectTo} />;

  if (!process.env[databaseVariable(process.env)]) {
    return (
      <main className="setup-page">
        <section className="setup-card">
          <CakeIcon size={48} className="setup-icon" />
          <p className="kicker">SETUP REQUIRED</p>
          <h1>データベースを接続してください</h1>
          <p><code>.env.example</code>を参考にNeonの接続情報と<code>AUTH_SECRET</code>を設定し、<code>npm run db:setup</code>を実行してください。</p>
        </section>
      </main>
    );
  }

  const initialData = await getBootstrap(user, workspaceId);
  return <Dashboard initialData={initialData} initialTab={initialTab} testAuth={testAuth} />;
}
