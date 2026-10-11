using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http;
using Serilog;

namespace Hub.Service.Api;

/// <summary>
/// <c>GET /v1/stream</c> (docs/hub-api.md): one WebSocket per client. A client first gets a full snapshot of every
/// state type, then a fresh snapshot of a type whenever it changes. Changes are coalesced: each state type is sent at
/// most once per <see cref="MinInterval"/>. Events (<c>notification</c>) are sent individually, in order.
/// </summary>
public sealed class StreamHub : IAsyncDisposable
{
    public static readonly TimeSpan MinInterval = TimeSpan.FromMilliseconds(100);
    private const int ClientQueue = 512;

    private readonly IReadOnlyList<(string Type, Func<object> Data)> _states;
    private readonly IReadOnlyList<(string Type, Func<IReadOnlyList<object>> Drain)> _deltas;
    private readonly ConcurrentDictionary<Guid, Client> _clients = new();
    private readonly ConcurrentDictionary<string, byte> _dirty = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<byte[]> _events = new();
    private readonly SemaphoreSlim _signal = new(0);
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _loop;

    /// <param name="states">State types in snapshot order with their current data (called on the hub's loop thread).</param>
    /// <param name="deltas">Delta types: when marked dirty, their pending changes are drained and each one is sent as its own
    /// frame. They are not part of the connect snapshot (clients fetch a full view over REST).</param>
    public StreamHub(IReadOnlyList<(string Type, Func<object> Data)> states, IReadOnlyList<(string Type, Func<IReadOnlyList<object>> Drain)>? deltas = null)
    {
        _states = states;
        _deltas = deltas ?? [];
        _loop = Task.Run(LoopAsync);
    }

    public int ClientCount => _clients.Count;

    /// <summary>The state of <paramref name="type"/> changed; its snapshot is resent soon.</summary>
    public void MarkDirty(string type)
    {
        _dirty[type] = 0;
        _signal.Release();
    }

    /// <summary>Sends a one-off event to every connected client.</summary>
    public void Publish(string type, object data)
    {
        if (_clients.IsEmpty)
        {
            return;
        }

        _events.Enqueue(Frame(type, data));
        _signal.Release();
    }

    /// <summary>Runs one WebSocket connection until the client or the hub closes it.</summary>
    public async Task AcceptAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token, context.RequestAborted);
        var client = new Client(socket);
        var id = Guid.NewGuid();
        _clients[id] = client;
        try
        {
            // Registered before the snapshot is queued: a change racing the connect is sent twice, never lost.
            foreach (var (type, data) in _states)
            {
                client.Queue.Writer.TryWrite(Frame(type, data()));
            }

            var sender = SendAsync(client, linked.Token);
            await ReceiveUntilClosedAsync(socket, linked.Token);
            client.Queue.Writer.TryComplete();
            await sender;
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
        }
        finally
        {
            _clients.TryRemove(id, out _);
            await CloseAsync(socket);
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var client in _clients.Values)
        {
            client.Queue.Writer.TryComplete();
        }

        await _stop.CancelAsync();
        await Task.WhenAny(_loop, Task.Delay(TimeSpan.FromSeconds(1)));
        _stop.Dispose();
        _signal.Dispose();
    }

    private async Task LoopAsync()
    {
        var token = _stop.Token;
        try
        {
            while (!token.IsCancellationRequested)
            {
                await _signal.WaitAsync(token);
                await Task.Delay(MinInterval, token);
                while (_signal.CurrentCount > 0)
                {
                    await _signal.WaitAsync(token);
                }

                Flush();
            }
        }
        catch (OperationCanceledException)
        {
        }
#pragma warning disable CA1031 // The loop must survive a failing data source; the next change retries.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            Log.Error(ex, "Stream loop failed");
        }
    }

    private void Flush()
    {
        foreach (var (type, data) in _states)
        {
            if (!_dirty.TryRemove(type, out _) || _clients.IsEmpty)
            {
                continue;
            }

            Broadcast(Frame(type, data()));
        }

        foreach (var (type, drain) in _deltas)
        {
            if (!_dirty.TryRemove(type, out _))
            {
                continue;
            }

            // Drained even without clients, so changes never pile up.
            foreach (var item in drain())
            {
                if (!_clients.IsEmpty)
                {
                    Broadcast(Frame(type, item));
                }
            }
        }

        while (_events.TryDequeue(out var frame))
        {
            Broadcast(frame);
        }
    }

    private void Broadcast(byte[] frame)
    {
        foreach (var client in _clients.Values)
        {
            client.Queue.Writer.TryWrite(frame);
        }
    }

    private static byte[] Frame(string type, object data) => ApiJson.Serialize(new StreamFrame(type, data));

    private static async Task SendAsync(Client client, CancellationToken ct)
    {
        try
        {
            await foreach (var frame in client.Queue.Reader.ReadAllAsync(ct))
            {
                await client.Socket.SendAsync(frame, WebSocketMessageType.Text, endOfMessage: true, ct);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
        }
    }

    private static async Task ReceiveUntilClosedAsync(WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[1024];
        while (socket.State == WebSocketState.Open)
        {
            // Clients only listen; anything they send is read and dropped.
            var result = await socket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return;
            }
        }
    }

    private static async Task CloseAsync(WebSocket socket)
    {
        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            try
            {
                await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", timeout.Token);
            }
            catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
            {
            }
        }
    }

    private sealed class Client(WebSocket socket)
    {
        public WebSocket Socket { get; } = socket;

        // A slow client loses its oldest frames rather than holding the hub's memory; state frames are snapshots anyway.
        public Channel<byte[]> Queue { get; } = Channel.CreateBounded<byte[]>(
            new BoundedChannelOptions(ClientQueue) { SingleReader = true, FullMode = BoundedChannelFullMode.DropOldest });
    }
}

/// <summary>Every stream frame: <c>{ "type", "data" }</c>.</summary>
public sealed record StreamFrame(string Type, object Data);
