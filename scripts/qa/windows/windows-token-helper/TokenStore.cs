using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

namespace CakeQaHelper
{
    public sealed class SafeFailure : Exception
    {
        public string Code { get; private set; }
        public SafeFailure(string code) : base(code) { Code = code; }
    }

    public sealed class TokenStore
    {
        public const string ProjectId = "prj_Z37vquodhpRd08ZTAtYnP0qa59jD";
        public const string TeamId = "team_D1Mcx2TdFWPKcypfu8KzNMub";
        public const string Format = "cake-token-dpapi/v1";
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("CakeQa/" + ProjectId + "/" + TeamId + "/v1");
        private readonly SecurityIdentifier userSid;
        public string RootPath { get; private set; }
        public string TokenPath { get { return Path.Combine(RootPath, "vercel-token.dpapi.json"); } }
        public bool Exists { get { return File.Exists(TokenPath) || Directory.Exists(TokenPath); } }
        public string UserSid { get { return userSid.Value; } }

        public TokenStore(string root)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) throw new SafeFailure("WINDOWS_REQUIRED");
            RootPath = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            userSid = WindowsIdentity.GetCurrent().User;
            if (userSid == null) throw new SafeFailure("WINDOWS_IDENTITY_UNAVAILABLE");
        }

        public static DirectorySecurity DirectoryAcl(SecurityIdentifier sid)
        {
            DirectorySecurity acl = new DirectorySecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.SetOwner(sid);
            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
            return acl;
        }

        public static FileSecurity FileAcl(SecurityIdentifier sid)
        {
            FileSecurity acl = new FileSecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.SetOwner(sid);
            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
            return acl;
        }

        public void CreateFreshRoot()
        {
            RejectReparseAncestors(RootPath);
            if (Directory.Exists(RootPath) || File.Exists(RootPath)) throw new SafeFailure("DIRECTORY_ALREADY_EXISTS");
            try { Directory.CreateDirectory(RootPath, DirectoryAcl(userSid)); }
            catch { throw new SafeFailure("DIRECTORY_CREATE_FAILED"); }
            ValidateRoot();
        }

        public void ValidateRoot()
        {
            if (!Directory.Exists(RootPath)) throw new SafeFailure("STORE_DIRECTORY_MISSING");
            RejectReparseAncestors(RootPath);
            try { ValidateAcl(Directory.GetAccessControl(RootPath), true); }
            catch (SafeFailure) { throw; }
            catch { throw new SafeFailure("STORE_ACCESS_CHECK_FAILED"); }
        }

        public void ValidateNewStore()
        {
            ValidateRoot();
            if (Exists) throw new SafeFailure("TOKEN_ALREADY_EXISTS");
        }

        private void ValidateAcl(FileSystemSecurity acl, bool directory)
        {
            if (!acl.AreAccessRulesProtected || !userSid.Equals(acl.GetOwner(typeof(SecurityIdentifier))))
                throw new SafeFailure("STORE_ACL_REJECTED");
            AuthorizationRuleCollection rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
            if (rules.Count != 1) throw new SafeFailure("STORE_ACL_REJECTED");
            FileSystemAccessRule rule = (FileSystemAccessRule)rules[0];
            InheritanceFlags expected = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
            if (!userSid.Equals(rule.IdentityReference) || rule.AccessControlType != AccessControlType.Allow || rule.IsInherited
                || (rule.FileSystemRights & FileSystemRights.FullControl) != FileSystemRights.FullControl
                || rule.InheritanceFlags != expected || rule.PropagationFlags != PropagationFlags.None)
                throw new SafeFailure("STORE_ACL_REJECTED");
        }

        public static void RejectReparseAncestors(string path)
        {
            string current = Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current))
            {
                if (Directory.Exists(current) || File.Exists(current))
                {
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                        throw new SafeFailure("REPARSE_POINT_REJECTED");
                }
                DirectoryInfo parent = Directory.GetParent(current);
                if (parent == null) break;
                current = parent.FullName;
            }
        }

        public void Save(SecureString token)
        {
            ValidateNewStore();
            byte[] clear = null;
            byte[] encrypted = null;
            try
            {
                clear = SecureBytes(token);
                encrypted = ProtectedData.Protect(clear, Entropy, DataProtectionScope.CurrentUser);
                Dictionary<string, object> record = new Dictionary<string, object>();
                record["format"] = Format;
                record["projectId"] = ProjectId;
                record["teamId"] = TeamId;
                record["protectedForSid"] = userSid.Value;
                record["createdUtc"] = DateTime.UtcNow.ToString("o");
                record["protectedToken"] = Convert.ToBase64String(encrypted);
                byte[] serialized = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(record));
                try
                {
                    // CreateNew refuses a race as well as an already-existing token; the ACL is attached at creation.
                    using (FileStream stream = new FileStream(TokenPath, FileMode.CreateNew, FileSystemRights.Write,
                        FileShare.None, 4096, FileOptions.None, FileAcl(userSid)))
                    {
                        stream.Write(serialized, 0, serialized.Length);
                        stream.Flush(true);
                    }
                }
                catch (IOException)
                {
                    if (Exists) throw new SafeFailure("TOKEN_EXISTS_OR_SAVE_INCOMPLETE");
                    throw new SafeFailure("TOKEN_SAVE_FAILED");
                }
                finally { Array.Clear(serialized, 0, serialized.Length); }
                ValidateTokenFile();
            }
            catch (SafeFailure) { throw; }
            catch { throw new SafeFailure("TOKEN_SAVE_FAILED"); }
            finally
            {
                if (clear != null) Array.Clear(clear, 0, clear.Length);
                if (encrypted != null) Array.Clear(encrypted, 0, encrypted.Length);
            }
        }

        private static byte[] SecureBytes(SecureString token)
        {
            if (token == null || token.Length < 12 || token.Length > 32768) throw new SafeFailure("TOKEN_FORMAT_REJECTED");
            IntPtr pointer = IntPtr.Zero;
            char[] characters = new char[token.Length];
            try
            {
                pointer = Marshal.SecureStringToGlobalAllocUnicode(token);
                Marshal.Copy(pointer, characters, 0, characters.Length);
                if (characters[0] != 'v' || characters[1] != 'c' || characters[2] != 'p' || characters[3] != '_')
                    throw new SafeFailure("TOKEN_FORMAT_REJECTED");
                foreach (char character in characters)
                    if (Char.IsWhiteSpace(character) || character < 33 || character > 126) throw new SafeFailure("TOKEN_FORMAT_REJECTED");
                return Encoding.UTF8.GetBytes(characters);
            }
            finally
            {
                Array.Clear(characters, 0, characters.Length);
                if (pointer != IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(pointer);
            }
        }

        public void ValidateTokenFile()
        {
            ValidateRoot();
            if (!File.Exists(TokenPath)) throw new SafeFailure("TOKEN_NOT_SAVED");
            RejectReparseAncestors(TokenPath);
            try
            {
                ValidateAcl(File.GetAccessControl(TokenPath), false);
                long length = new FileInfo(TokenPath).Length;
                if (length < 100 || length > 131072) throw new SafeFailure("TOKEN_FILE_REJECTED");
            }
            catch (SafeFailure) { throw; }
            catch { throw new SafeFailure("TOKEN_FILE_REJECTED"); }
        }

        // Only the explicit preflight/verify launcher and isolated dummy tests
        // decrypt a record. The input form and status never read its contents.
        public byte[] UnprotectForChild()
        {
            ValidateTokenFile();
            byte[] encrypted = null;
            try
            {
                Dictionary<string, object> record = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(TokenPath, Encoding.UTF8));
                if (record.Count != 6 || !ValueEquals(record, "format", Format) || !ValueEquals(record, "projectId", ProjectId)
                    || !ValueEquals(record, "teamId", TeamId) || !ValueEquals(record, "protectedForSid", userSid.Value))
                    throw new SafeFailure("TOKEN_FILE_REJECTED");
                object cipher;
                if (!record.TryGetValue("protectedToken", out cipher) || !(cipher is string)) throw new SafeFailure("TOKEN_FILE_REJECTED");
                encrypted = Convert.FromBase64String((string)cipher);
                return ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
            }
            catch (SafeFailure) { throw; }
            catch { throw new SafeFailure("TOKEN_DECRYPT_FAILED"); }
            finally { if (encrypted != null) Array.Clear(encrypted, 0, encrypted.Length); }
        }

        private static bool ValueEquals(Dictionary<string, object> record, string key, string expected)
        {
            object value;
            return record.TryGetValue(key, out value) && value is string && (string)value == expected;
        }
    }
}
