using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using Hub.Core;
using Hub.Core.Ai;
using Hub.Infrastructure.Ai;

namespace Hub.Infrastructure.Platform;

/// <summary>Platform layer (AGENTS.md rule 7): the secret store for this OS.</summary>
public static class SecretStores
{
    /// <summary>
    /// Windows Credential Manager under the brand's prefix, falling back to legacy prefixes from before a rename (keys found
    /// there are moved over on first read); elsewhere a store that holds nothing (macOS Keychain comes later).
    /// </summary>
    public static ISecretStore ForCurrentPlatform()
    {
        if (!OperatingSystem.IsWindows())
        {
            return new UnavailableSecretStore();
        }

        var brand = Brand.Current;
        return new MigratingSecretStore(
            new WindowsCredentialStore(brand.CredentialPrefix, brand.Slug),
            [.. brand.LegacyCredentialPrefixes.Where(p => p != brand.CredentialPrefix).Select(p => new WindowsCredentialStore(p, brand.Slug))]);
    }
}

/// <summary>No vault on this platform yet: reads find nothing, writes throw.</summary>
public sealed class UnavailableSecretStore : ISecretStore
{
    public bool IsAvailable => false;

    public string? Read(string name) => null;

    public void Write(string name, string secret) => throw new PlatformNotSupportedException("No secret store on this platform yet.");

    public bool Delete(string name) => false;
}

/// <summary>
/// AI provider keys in Windows Credential Manager: generic credentials, target <c>&lt;prefix&gt;&lt;name&gt;</c> (the brand's
/// <c>&lt;slug&gt;/ai/</c>), persisted for the local machine (this user only, not roamed). The secret is never logged; managed
/// copies are zeroed after use.
/// </summary>
public sealed class WindowsCredentialStore(string targetPrefix, string userName) : ISecretStore
{
    /// <summary>CRED_MAX_CREDENTIAL_BLOB_SIZE (5 × 512 bytes) in UTF-16 characters.</summary>
    public const int MaxSecretLength = 1280;

    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;

    public bool IsAvailable => true;

    public string Target(string name) => targetPrefix + name;

    public string? Read(string name)
    {
        if (!CredReadW(Target(name), CredTypeGeneric, 0, out var handle))
        {
            var error = Marshal.GetLastWin32Error();
            return error == ErrorNotFound ? null : throw new IOException($"CredRead failed ({error}).");
        }

        try
        {
            var credential = Marshal.PtrToStructure<Credential>(handle);
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0)
            {
                return null;
            }

            var bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            try
            {
                return Encoding.Unicode.GetString(bytes);
            }
            finally
            {
                Array.Clear(bytes);
            }
        }
        finally
        {
            CredFree(handle);
        }
    }

    public void Write(string name, string secret)
    {
        if (secret.Length > MaxSecretLength)
        {
            throw new ArgumentException($"At most {MaxSecretLength} characters.", nameof(secret));
        }

        var bytes = Encoding.Unicode.GetBytes(secret);
        var blob = Marshal.AllocHGlobal(Math.Max(bytes.Length, 1));
        var target = Marshal.StringToHGlobalUni(Target(name));
        var user = Marshal.StringToHGlobalUni(userName);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new Credential
            {
                Type = CredTypeGeneric,
                TargetName = target,
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob,
                Persist = CredPersistLocalMachine,
                UserName = user,
            };
            if (!CredWriteW(ref credential, 0))
            {
                throw new IOException($"CredWrite failed ({Marshal.GetLastWin32Error()}).");
            }
        }
        finally
        {
            Array.Clear(bytes);
            Marshal.Copy(new byte[bytes.Length], 0, blob, bytes.Length);
            Marshal.FreeHGlobal(blob);
            Marshal.FreeHGlobal(target);
            Marshal.FreeHGlobal(user);
        }
    }

    public bool Delete(string name)
    {
        if (CredDeleteW(Target(name), CredTypeGeneric, 0))
        {
            return true;
        }

        var error = Marshal.GetLastWin32Error();
        return error == ErrorNotFound ? false : throw new IOException($"CredDelete failed ({error}).");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern void CredFree(IntPtr buffer);
}
