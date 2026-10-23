using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CakeQaHelper
{
    internal static class TokenRunner
    {
        private static readonly string[] EnvironmentAllowlist = {
            "SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "APPDATA",
            "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS",
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
            "SSL_CERT_DIR", "PLAYWRIGHT_BROWSERS_PATH"
        };
        private static readonly HashSet<string> ChildCodes = new HashSet<string>(StringComparer.Ordinal) {
            "OK", "INTERNAL_ERROR", "UNSAFE_RUNTIME", "TOKEN_MISSING", "NETWORK_ERROR", "AUTH_REJECTED", "HTTP_ERROR",
            "NON_JSON_RESPONSE", "RESPONSE_TOO_LARGE", "OIDC_MISSING", "OIDC_INVALID", "OIDC_IDENTITY_OR_EXPIRY_MISMATCH",
            "QA_FAILED", "QA_CONFIG_REJECTED", "QA_RUNTIME_REJECTED", "QA_TOOL_UNAVAILABLE", "QA_LOCAL_IDENTITY_REJECTED",
            "QA_TARGET_IDENTITY_REJECTED", "QA_RESOURCE_IDENTITY_REJECTED", "QA_COMMAND_REJECTED", "QA_CONTROL_MAIN_CHANGED",
            "QA_RECEIPT_REJECTED", "QA_PROOF_REJECTED", "QA_SCREENSHOTS_REJECTED", "QA_EVIDENCE_WRITE_FAILED",
            "PREVIEW_API_UNAVAILABLE", "PREVIEW_PR_CHANGED", "PREVIEW_MAIN_UNAVAILABLE", "PREVIEW_NOT_INSTALLED_ON_MAIN",
            "PREVIEW_WORKFLOW_CHANGED", "PREVIEW_RUN_UNAVAILABLE", "PREVIEW_RUN_AMBIGUOUS", "PREVIEW_RUN_CHANGED",
            "PREVIEW_RUN_INCOMPLETE", "PREVIEW_RUN_FAILED", "PREVIEW_JOBS_INCOMPLETE", "PREVIEW_JOB_AMBIGUOUS",
            "PREVIEW_JOB_CHANGED", "PREVIEW_CHECK_URL", "PREVIEW_CHECK_CHANGED", "PREVIEW_SUITE_CHANGED",
            "PREVIEW_ANNOTATIONS_INCOMPLETE", "PREVIEW_RECEIPT_AMBIGUOUS", "PREVIEW_RECEIPT_INVALID",
            "PREVIEW_RECEIPT_TOO_LARGE", "PREVIEW_CURRENT_DRAFT_PR_REQUIRED", "PREVIEW_READY_REQUIRED",
            "PREVIEW_BROWSER_FAILED", "PREVIEW_CHANGED_DURING_VERIFICATION"
        };
        private static readonly HashSet<string> FailureCodes = new HashSet<string>(StringComparer.Ordinal) {
            "WINDOWS_REQUIRED", "WINDOWS_IDENTITY_UNAVAILABLE", "WINDOWS_PROFILE_UNAVAILABLE", "WINDOWS_PROFILE_CONTEXT_REJECTED", "DIRECTORY_ALREADY_EXISTS",
            "DIRECTORY_CREATE_FAILED", "STORE_DIRECTORY_MISSING", "STORE_ACCESS_CHECK_FAILED", "STORE_ACL_REJECTED",
            "TOKEN_ALREADY_EXISTS", "REPARSE_POINT_REJECTED", "TOKEN_FORMAT_REJECTED", "TOKEN_EXISTS_OR_SAVE_INCOMPLETE",
            "TOKEN_SAVE_FAILED", "TOKEN_NOT_SAVED", "TOKEN_FILE_REJECTED", "TOKEN_DECRYPT_FAILED", "ARGUMENTS_REJECTED",
            "METADATA_WRITE_FAILED", "CHILD_INTEGRITY_REJECTED", "REQUIRED_PATH_MISSING", "CONTROL_CHECKOUT_REJECTED",
            "NODE_EXECUTABLE_UNAVAILABLE", "CHILD_START_FAILED", "CHILD_TIMEOUT", "CHILD_RESPONSE_REJECTED",
            "CHILD_EXECUTION_FAILED", "SELF_TEST_PATH_REJECTED", "SELF_TEST_FAILED", "QA_PROOF_INVALIDATION_FAILED"
        };

        internal static bool IsPublicFailureCode(string code) { return FailureCodes.Contains(code); }

        internal static Dictionary<string, object> RunTrusted(TokenStore store, string mode)
        {
            if (mode != "preflight" && mode != "verify") throw new SafeFailure("ARGUMENTS_REJECTED");
            // Every check runs before reading the DPAPI record. BuildInfo is
            // generated from this invocation's discovered paths and public request.
            RequirePaths();
            ValidateChildHash(BuildInfo.ChildPath, BuildInfo.ChildSha256);
            ValidateChildHash(BuildInfo.LoaderPath, BuildInfo.LoaderSha256);
            ValidateChildHash(BuildInfo.ConfigPath, BuildInfo.ConfigSha256);
            ReadConfig(mode);
            AssertControlCheckout();
            string target = mode == "verify" ? ValidateTargetRequest() : null;
            try
            {
                Dictionary<string, object> result = Run(store, BuildInfo.ChildPath, BuildInfo.ChildSha256,
                    false, SafeParentEnvironment(), "--import " + QuoteWindowsArgument(new Uri(BuildInfo.LoaderPath).AbsoluteUri) + " " +
                    QuoteWindowsArgument(BuildInfo.ChildPath) + " --broker-mode " + mode + " --broker-config " + QuoteWindowsArgument(BuildInfo.ConfigPath),
                    mode, mode == "verify" ? 3600000 : 60000);
                // A success is unusable if the request or implementation changed.
                ValidateChildHash(BuildInfo.ChildPath, BuildInfo.ChildSha256);
                ValidateChildHash(BuildInfo.LoaderPath, BuildInfo.LoaderSha256);
                ValidateChildHash(BuildInfo.ConfigPath, BuildInfo.ConfigSha256);
                AssertControlCheckout();
                if (mode == "verify")
                {
                    ValidateTargetRequest();
                    if (!(bool)result["success"]) InvalidateProof(target);
                }
                return result;
            }
            catch
            {
                if (target != null) InvalidateProof(target);
                throw;
            }
        }

        private static void RequirePaths()
        {
            foreach (string path in new string[] { BuildInfo.ControlRoot, BuildInfo.SourceRoot, BuildInfo.NodeExe,
                BuildInfo.GitExe, BuildInfo.GhExe, BuildInfo.LoaderPath, BuildInfo.ChildPath, BuildInfo.ConfigPath })
            {
                if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path) || (!File.Exists(path) && !Directory.Exists(path)))
                    throw new SafeFailure("REQUIRED_PATH_MISSING");
                TokenStore.RejectReparseAncestors(path);
            }
            string root = Path.GetFullPath(BuildInfo.ControlRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            foreach (string path in new string[] { BuildInfo.SourceRoot, BuildInfo.LoaderPath, BuildInfo.ChildPath, BuildInfo.ConfigPath })
                if (!Path.GetFullPath(path).StartsWith(root, StringComparison.OrdinalIgnoreCase) &&
                    !String.Equals(Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                    throw new SafeFailure("REQUIRED_PATH_MISSING");
        }

        private static void AssertControlCheckout()
        {
            if (BuildInfo.ControlSha.Length != 40) throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
            foreach (char c in BuildInfo.ControlSha)
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
            AssertGit(BuildInfo.ControlRoot, "rev-parse --show-toplevel", Path.GetFullPath(BuildInfo.ControlRoot));
            AssertGit(BuildInfo.ControlRoot, "rev-parse HEAD", BuildInfo.ControlSha);
            AssertGit(BuildInfo.ControlRoot, "status --porcelain=v1 --untracked-files=normal", "");
            AssertRepositoryOrigin(BuildInfo.ControlRoot);
        }

        private static string GitText(string cwd, string arguments)
        {
            using (Process process = new Process())
            {
                process.StartInfo = NewProcess(BuildInfo.GitExe, arguments, cwd, SafeParentEnvironment());
                try
                {
                    if (!process.Start()) throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
                    Task<string> stdout = process.StandardOutput.ReadToEndAsync();
                    Task<string> stderr = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(30000)) { StopOwnedTree(process); throw new SafeFailure("CONTROL_CHECKOUT_REJECTED"); }
                    if (!Task.WaitAll(new Task[] { stdout, stderr }, 5000) || process.ExitCode != 0)
                        throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
                    return stdout.Result.Trim();
                }
                catch (SafeFailure) { throw; }
                catch { throw new SafeFailure("CONTROL_CHECKOUT_REJECTED"); }
            }
        }

        private static void AssertGit(string cwd, string arguments, string expected)
        {
            string actual = GitText(cwd, arguments);
            if (arguments == "rev-parse --show-toplevel") actual = Path.GetFullPath(actual);
            if (!String.Equals(actual, expected, arguments == "rev-parse --show-toplevel" ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
        }

        private static string ValidateTargetRequest()
        {
            try
            {
                Dictionary<string, object> config = ReadConfig("verify");
                object targetValue, shaValue;
                if (config == null || !config.TryGetValue("targetWorktree", out targetValue) || !(targetValue is string) ||
                    !config.TryGetValue("sha", out shaValue) || !(shaValue is string) || !Regex.IsMatch((string)shaValue, "^[a-f0-9]{40}$"))
                    throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
                string target = Path.GetFullPath((string)targetValue).TrimEnd(Path.DirectorySeparatorChar);
                if (!Path.IsPathRooted((string)targetValue) || !Directory.Exists(target)) throw new SafeFailure("REQUIRED_PATH_MISSING");
                TokenStore.RejectReparseAncestors(target);
                AssertGit(target, "rev-parse --show-toplevel", target);
                AssertGit(target, "rev-parse HEAD", (string)shaValue);
                AssertGit(target, "status --porcelain=v1 --untracked-files=normal", "");
                string branch = GitText(target, "branch --show-current");
                if (branch.Length > 66 || !Regex.IsMatch(branch, "^codex/[a-z0-9]+(?:-[a-z0-9]+)*$") ||
                    branch == "codex/main" || branch == "codex/preview" || branch == "codex/production") throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
                AssertRepositoryOrigin(target);
                TokenStore.RejectReparseAncestors(Path.Combine(target, ".cake", "verification.json"));
                return target;
            }
            catch (SafeFailure) { throw; }
            catch { throw new SafeFailure("CONTROL_CHECKOUT_REJECTED"); }
        }

        private static Dictionary<string, object> ReadConfig(string mode)
        {
            try
            {
                ValidateChildHash(BuildInfo.ConfigPath, BuildInfo.ConfigSha256);
                if (new FileInfo(BuildInfo.ConfigPath).Length > 16384) throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
                Dictionary<string, object> config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(BuildInfo.ConfigPath, Encoding.UTF8));
                ValidateConfigValues(config, mode);
                return config;
            }
            catch (SafeFailure) { throw; }
            catch { throw new SafeFailure("CONTROL_CHECKOUT_REJECTED"); }
        }

        private static void AssertRepositoryOrigin(string cwd)
        {
            if (!Regex.IsMatch(GitText(cwd, "remote get-url origin"), @"^(?:git@github\.com:|https://github\.com/|ssh://git@github\.com/)tyask/Cake(?:\.git)?$"))
                throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
        }

        private static void ValidateConfigValues(Dictionary<string, object> config, string mode)
        {
            string[] common = { "protocol", "mode", "controlCwd", "controlSha", "gitExe", "ghExe" };
            string[] extra = { "targetWorktree", "pr", "sha", "deploymentId", "databaseBranchId", "generation" };
            if (config == null || config.Count != common.Length + (mode == "verify" ? extra.Length : 0))
                throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
            foreach (string key in common) if (!config.ContainsKey(key)) throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
            if (mode == "verify") foreach (string key in extra) if (!config.ContainsKey(key)) throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
            if (!StringValue(config, "protocol", "cake-windows-qa-request/v1") || !StringValue(config, "mode", mode) ||
                !StringValue(config, "controlSha", BuildInfo.ControlSha) || !PathValue(config, "controlCwd", BuildInfo.ControlRoot) ||
                !PathValue(config, "gitExe", BuildInfo.GitExe) || !PathValue(config, "ghExe", BuildInfo.GhExe))
                throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
            if (mode == "verify" && (!(config["targetWorktree"] is string) || !Path.IsPathRooted((string)config["targetWorktree"]) ||
                !(config["pr"] is int) || (int)config["pr"] < 1 || !PatternValue(config, "sha", "^[a-f0-9]{40}$") ||
                !PatternValue(config, "deploymentId", "^dpl_[A-Za-z0-9]+$") || !PatternValue(config, "databaseBranchId", "^br-[a-z0-9-]+$") ||
                !PatternValue(config, "generation", "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")))
                throw new SafeFailure("CONTROL_CHECKOUT_REJECTED");
        }

        private static bool PatternValue(Dictionary<string, object> values, string key, string pattern)
        {
            object value;
            return values.TryGetValue(key, out value) && value is string && Regex.IsMatch((string)value, pattern);
        }

        internal static bool AcceptsValidDummyVerifyConfig(string dummyTarget)
        {
            Dictionary<string, object> dummy = new Dictionary<string, object> {
                { "protocol", "cake-windows-qa-request/v1" }, { "mode", "verify" }, { "controlCwd", BuildInfo.ControlRoot },
                { "controlSha", BuildInfo.ControlSha }, { "gitExe", BuildInfo.GitExe }, { "ghExe", BuildInfo.GhExe },
                { "targetWorktree", dummyTarget }, { "pr", 1 }, { "sha", new string('0', 40) }, { "deploymentId", "dpl_dummy" },
                { "databaseBranchId", "br-dummy" }, { "generation", "00000000-0000-4000-8000-000000000000" }
            };
            ValidateConfigValues(dummy, "verify");
            return true;
        }

        private static bool StringValue(Dictionary<string, object> values, string key, string expected)
        {
            object value;
            return values.TryGetValue(key, out value) && value is string && (string)value == expected;
        }

        private static bool PathValue(Dictionary<string, object> values, string key, string expected)
        {
            object value;
            return values.TryGetValue(key, out value) && value is string && Path.IsPathRooted((string)value) &&
                String.Equals(Path.GetFullPath((string)value).TrimEnd(Path.DirectorySeparatorChar),
                    Path.GetFullPath(expected).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
        }

        private static void InvalidateProof(string target)
        {
            try
            {
                string path = Path.Combine(target, ".cake", "verification.json");
                TokenStore.RejectReparseAncestors(path);
                if (!File.Exists(path)) return;
                using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                {
                    if (stream.Length > 2097152) throw new SafeFailure("QA_PROOF_INVALIDATION_FAILED");
                    byte[] original = new byte[(int)stream.Length];
                    int position = 0;
                    while (position < original.Length)
                    {
                        int count = stream.Read(original, position, original.Length - position);
                        if (count == 0) throw new SafeFailure("QA_PROOF_INVALIDATION_FAILED");
                        position += count;
                    }
                    Dictionary<string, object> proof;
                    try { proof = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(original)); }
                    catch { proof = new Dictionary<string, object>(); }
                    object success;
                    if (proof != null && proof.TryGetValue("success", out success) && success is bool && !(bool)success) return;
                    if (proof == null) proof = new Dictionary<string, object>();
                    proof["success"] = false;
                    proof["runnerFailureCode"] = "WINDOWS_QA_RUNNER_NOT_COMPLETED";
                    byte[] safe = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(proof) + "\n");
                    stream.Position = 0;
                    stream.SetLength(0);
                    stream.Write(safe, 0, safe.Length);
                    stream.Flush(true);
                }
            }
            catch { throw new SafeFailure("QA_PROOF_INVALIDATION_FAILED"); }
        }

        internal static void InvalidateDummyProof(string target)
        {
            string full = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
            string testBase = Path.GetFullPath(BuildInfo.TestBase).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string actualStore = Path.GetFullPath(RuntimePaths.StoreRoot).TrimEnd(Path.DirectorySeparatorChar);
            if (!full.StartsWith(testBase, StringComparison.OrdinalIgnoreCase) ||
                String.Equals(full, actualStore, StringComparison.OrdinalIgnoreCase) ||
                full.StartsWith(actualStore + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                actualStore.StartsWith(full + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new SafeFailure("SELF_TEST_PATH_REJECTED");
            InvalidateProof(full);
        }

        internal static bool RejectsUnexpectedChildFields()
        {
            try
            {
                SanitizeResponse("{\"protocol\":\"cake-token-dummy/v1\",\"success\":true,\"dummyMatched\":true," +
                    "\"unwantedEnvironmentAbsent\":true,\"networkRequests\":0,\"unexpected\":\"public-dummy-only\"}", true, "dummy");
                return false;
            }
            catch (SafeFailure failure) { return failure.Code == "CHILD_RESPONSE_REJECTED"; }
        }

        internal static Dictionary<string, object> RunDummy(TokenStore store, Dictionary<string, string> testSource)
        {
            return Run(store, BuildInfo.DummyChildPath, BuildInfo.DummyChildSha256, true, testSource,
                QuoteWindowsArgument(BuildInfo.DummyChildPath), "dummy", 30000);
        }

        internal static void RejectTamperedDummyBeforeDecrypt(TokenStore store, string testScript)
        {
            string full = Path.GetFullPath(testScript);
            string testBase = Path.GetFullPath(BuildInfo.TestBase).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(testBase, StringComparison.OrdinalIgnoreCase) || Path.GetFileName(full) != "dummy-child.mjs")
                throw new SafeFailure("SELF_TEST_PATH_REJECTED");
            Run(store, full, BuildInfo.DummyChildSha256, true, SafeParentEnvironment(), QuoteWindowsArgument(full), "dummy", 30000);
        }

        internal static Dictionary<string, string> SafeParentEnvironment()
        {
            Dictionary<string, string> source = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string key in EnvironmentAllowlist)
            {
                string value = Environment.GetEnvironmentVariable(key);
                if (!String.IsNullOrEmpty(value)) source[key] = value;
            }
            foreach (string key in new string[] { "NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY" })
                if (Environment.GetEnvironmentVariable(key) == "1") source[key] = "1";
            return source;
        }

        internal static Dictionary<string, string> FilterEnvironment(Dictionary<string, string> source)
        {
            Dictionary<string, string> filtered = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string key in EnvironmentAllowlist)
            {
                string value;
                if (source.TryGetValue(key, out value) && !String.IsNullOrEmpty(value)) filtered[key] = value;
            }
            foreach (string key in new string[] { "NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY" })
            {
                string value;
                if (source.TryGetValue(key, out value) && value == "1") filtered[key] = "1";
            }
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            filtered["PATH"] = Path.GetDirectoryName(BuildInfo.NodeExe) + ";" + Path.GetDirectoryName(BuildInfo.GitExe) + ";" +
                Path.GetDirectoryName(BuildInfo.GhExe) + ";" + Path.Combine(windows, "System32") + ";" + windows;
            filtered["GIT_TERMINAL_PROMPT"] = "0";
            filtered["GH_PROMPT_DISABLED"] = "1";
            filtered["GH_HOST"] = "github.com";
            return filtered;
        }

        private static ProcessStartInfo NewProcess(string executable, string arguments, string cwd, Dictionary<string, string> source)
        {
            ProcessStartInfo info = new ProcessStartInfo(executable, arguments);
            info.WorkingDirectory = cwd;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables.Clear();
            foreach (KeyValuePair<string, string> item in FilterEnvironment(source)) info.EnvironmentVariables[item.Key] = item.Value;
            return info;
        }

        private static Dictionary<string, object> Run(TokenStore store, string scriptPath, string expectedHash,
            bool dummy, Dictionary<string, string> source, string arguments, string mode, int timeout)
        {
            ValidateChildHash(scriptPath, expectedHash);
            if (!Path.IsPathRooted(BuildInfo.NodeExe) || !File.Exists(BuildInfo.NodeExe)) throw new SafeFailure("NODE_EXECUTABLE_UNAVAILABLE");
            TokenStore.RejectReparseAncestors(BuildInfo.NodeExe);
            byte[] clear = null;
            string token = null;
            Process child = null;
            ProcessStartInfo info = null;
            try
            {
                clear = store.UnprotectForChild();
                if (clear.Length < 12 || clear.Length > 32768) throw new SafeFailure("TOKEN_FORMAT_REJECTED");
                foreach (byte value in clear) if (value < 33 || value > 126) throw new SafeFailure("TOKEN_FORMAT_REJECTED");
                token = Encoding.UTF8.GetString(clear);
                if (!token.StartsWith("vcp_", StringComparison.Ordinal)) throw new SafeFailure("TOKEN_FORMAT_REJECTED");
                info = NewProcess(BuildInfo.NodeExe, arguments, dummy ? Path.GetDirectoryName(scriptPath) : BuildInfo.ControlRoot, source);
                info.EnvironmentVariables["VERCEL_TOKEN"] = token;
                child = new Process(); child.StartInfo = info;
                try { if (!child.Start()) throw new SafeFailure("CHILD_START_FAILED"); }
                catch { throw new SafeFailure("CHILD_START_FAILED"); }
                Task<string> stdout = child.StandardOutput.ReadToEndAsync();
                Task<string> stderr = child.StandardError.ReadToEndAsync();
                if (!child.WaitForExit(timeout)) { StopOwnedTree(child); throw new SafeFailure("CHILD_TIMEOUT"); }
                if (!Task.WaitAll(new Task[] { stdout, stderr }, 5000)) throw new SafeFailure("CHILD_TIMEOUT");
                // Raw output and stderr are never printed, copied or recorded.
                Dictionary<string, object> result = SanitizeResponse(stdout.Result, dummy, mode);
                if ((bool)result["success"] != (child.ExitCode == 0)) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
                return result;
            }
            catch (SafeFailure) { throw; }
            catch { throw new SafeFailure("CHILD_EXECUTION_FAILED"); }
            finally
            {
                if (clear != null) Array.Clear(clear, 0, clear.Length);
                if (info != null) info.EnvironmentVariables.Remove("VERCEL_TOKEN");
                token = null;
                if (child != null)
                {
                    try { if (!child.HasExited) StopOwnedTree(child); } catch { }
                    child.Dispose();
                }
                // Managed strings cannot be reliably zeroed. They have limited
                // lifetime; no plaintext is put in argv, files or the parent env.
            }
        }

        private static void StopOwnedTree(Process child)
        {
            try
            {
                string taskkill = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "taskkill.exe");
                using (Process killer = Process.Start(NewProcess(taskkill, "/PID " + child.Id + " /T /F", Path.GetTempPath(), SafeParentEnvironment())))
                {
                    Task<string> stdout = killer.StandardOutput.ReadToEndAsync();
                    Task<string> stderr = killer.StandardError.ReadToEndAsync();
                    killer.WaitForExit(5000);
                }
            }
            catch { try { child.Kill(); } catch { } }
        }

        private static void ValidateChildHash(string path, string expected)
        {
            try
            {
                if (expected == null || expected.Length != 64 || !Path.IsPathRooted(path) || !File.Exists(path))
                    throw new SafeFailure("CHILD_INTEGRITY_REJECTED");
                TokenStore.RejectReparseAncestors(path);
                using (SHA256 sha = SHA256.Create())
                using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                    if (!String.Equals(BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", ""), expected, StringComparison.OrdinalIgnoreCase))
                        throw new SafeFailure("CHILD_INTEGRITY_REJECTED");
            }
            catch (SafeFailure) { throw; }
            catch { throw new SafeFailure("CHILD_INTEGRITY_REJECTED"); }
        }

        private static Dictionary<string, object> SanitizeResponse(string output, bool dummy, string mode)
        {
            if (output == null || output.Length > 8192) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
            Dictionary<string, object> parsed;
            try { parsed = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(output); }
            catch { throw new SafeFailure("CHILD_RESPONSE_REJECTED"); }
            object value;
            string protocol = dummy ? "cake-token-dummy/v1" : "cake-windows-qa-child/v1";
            if (parsed == null || parsed.Count != (dummy ? 5 : 9) || !parsed.TryGetValue("protocol", out value) || !(value is string) || (string)value != protocol)
                throw new SafeFailure("CHILD_RESPONSE_REJECTED");
            Dictionary<string, object> safe = new Dictionary<string, object>(); safe["protocol"] = protocol;
            foreach (string key in dummy ? new string[] { "success", "dummyMatched", "unwantedEnvironmentAbsent" } :
                new string[] { "success", "oidcProjectMatches", "oidcOwnerMatches", "oidcDevelopment", "oidcExpiryValid" })
            {
                if (!parsed.TryGetValue(key, out value) || !(value is bool)) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
                safe[key] = value;
            }
            if (dummy)
            {
                if (!parsed.TryGetValue("networkRequests", out value) || !(value is int) || (int)value != 0) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
                safe["networkRequests"] = 0;
                if ((bool)safe["success"] != ((bool)safe["dummyMatched"] && (bool)safe["unwantedEnvironmentAbsent"]))
                    throw new SafeFailure("CHILD_RESPONSE_REJECTED");
                return safe;
            }
            if (!parsed.TryGetValue("mode", out value) || !(value is string) || (string)value != mode) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
            safe["mode"] = mode;
            if (!parsed.TryGetValue("code", out value) || !(value is string) || !ChildCodes.Contains((string)value)) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
            string code = (string)value; safe["code"] = code;
            if (((bool)safe["success"] && code != "OK") || (!(bool)safe["success"] && code == "OK")) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
            if ((bool)safe["success"] && !((bool)safe["oidcProjectMatches"] && (bool)safe["oidcOwnerMatches"] &&
                (bool)safe["oidcDevelopment"] && (bool)safe["oidcExpiryValid"])) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
            Dictionary<string, object> counts = parsed.ContainsKey("counts") ? parsed["counts"] as Dictionary<string, object> : null;
            string[] countKeys = { "statusDispatchCount", "statusReceiptCount", "clickCount", "caseCount", "observationCount", "screenshotCount", "elapsedMs" };
            int[] limits = { 2, 2, 16, 5, 12, 12, 3600000 };
            if (counts == null || counts.Count != countKeys.Length) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
            Dictionary<string, object> safeCounts = new Dictionary<string, object>();
            for (int i = 0; i < countKeys.Length; i++)
            {
                if (!counts.TryGetValue(countKeys[i], out value) || !(value is int) || (int)value < 0 || (int)value > limits[i])
                    throw new SafeFailure("CHILD_RESPONSE_REJECTED");
                safeCounts[countKeys[i]] = value;
            }
            if (mode == "preflight")
                for (int i = 0; i < countKeys.Length - 1; i++) if ((int)safeCounts[countKeys[i]] != 0) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
            if (mode == "verify" && (bool)safe["success"])
                for (int i = 0; i < countKeys.Length - 1; i++) if ((int)safeCounts[countKeys[i]] != limits[i]) throw new SafeFailure("CHILD_RESPONSE_REJECTED");
            safe["counts"] = safeCounts;
            return safe;
        }

        private static string QuoteWindowsArgument(string value)
        {
            StringBuilder result = new StringBuilder("\""); int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                result.Append('\\', slashes * (character == '"' ? 2 : 1) + (character == '"' ? 1 : 0));
                result.Append(character); slashes = 0;
            }
            result.Append('\\', slashes * 2); return result.Append('"').ToString();
        }
    }
}
