using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace YtSummary
{
    public sealed class Job
    {
        public string Id { get; set; }
        public string RequestId { get; set; }
        public string VideoId { get; set; }
        public string Title { get; set; }
        public int DurationSeconds { get; set; }
        public string SummaryLevel { get; set; }
        public string SummaryLanguage { get; set; }
        public string State { get; set; }
        public string Message { get; set; }
        public string ResultUrl { get; set; }
        public List<string> PartResultUrls { get; set; }
        public string ProviderName { get; set; }
        public int RotationCursor { get; set; }
        public int StageIndex { get; set; }
        public string Progress { get; set; }
        public string RetryReason { get; set; }
        public string TranscriptHash { get; set; }
        public int TranscriptLength { get; set; }
        public int ChunkCount { get; set; }
        public int SuccessfulParts { get; set; }
        public bool PausedByUser { get; set; }
        public bool WatchLater { get; set; }
        public bool TranscriptSaved { get; set; }
        public string AmbiguousTargetId { get; set; }
        public string AmbiguousTextSha256 { get; set; }
        public bool ReconcileAttempted { get; set; }
        public int AutoRetryAttempts { get; set; }
        public DateTime AutoRetryAfterUtc { get; set; }
        public string FinalResult { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime UpdatedAt { get; set; }
        public long Sequence { get; set; }
    }

    public sealed class PartCheckpointEntry
    {
        public string Text { get; set; }
        public string ResultUrl { get; set; }
        public string ProviderName { get; set; }
    }

    public sealed class TranscriptCache
    {
        public string VideoId { get; set; }
        public string Text { get; set; }
    }

    public sealed class PartCheckpoint
    {
        public string TranscriptHash { get; set; }
        public int TranscriptLength { get; set; }
        public int ChunkCount { get; set; }
        public string SummaryLevel { get; set; }
        public string PlanHash { get; set; }
        public List<PartCheckpointEntry> Parts { get; set; }
    }

    sealed class HttpError : Exception
    {
        public readonly int Status;
        public HttpError(int status, string message) : base(message) { Status = status; }
    }

    public sealed class LocalServer : IDisposable
    {
        readonly TcpListener listener;
        readonly string token;
        readonly string mobileAddress;
        readonly string html;
        readonly string script;
        readonly object gate = new object();
        readonly List<Job> jobs = new List<Job>();
        readonly Dictionary<string, PartCheckpoint> partCheckpoints = new Dictionary<string, PartCheckpoint>();
        readonly Queue<DateTime> submissions = new Queue<DateTime>();
        readonly Queue<string> acknowledgements = new Queue<string>();
        readonly HashSet<string> acknowledgementIds = new HashSet<string>();
        readonly Queue<string> stopJobRequests = new Queue<string>();
        readonly HashSet<string> stopJobRequestIds = new HashSet<string>();
        readonly HashSet<string> titleLookupInFlightIds = new HashSet<string>();
        readonly HashSet<string> reconcileInFlightIds = new HashSet<string>();
        readonly Dictionary<string, int> reconcileDeferrals = new Dictionary<string, int>();
        readonly HashSet<string> failureReportIds = new HashSet<string>();
        readonly Dictionary<string, DateTime> titleLookupRetryUtc = new Dictionary<string, DateTime>();
        readonly string stateDirectory;
        string pendingSendDirectory;
        readonly int maxConcurrent;
        readonly int startIntervalMilliseconds;
        DateTime nextStart = DateTime.MinValue;
        bool dispatchPaused;
        string pauseReason = "";
        // "usage" means a provider limit was hit and only the user may decide when to resume.
        // "restart" is the automatic hold placed on leftover queued videos after a restart; adding
        // a new video is an explicit request to work, so that hold clears itself.
        string pauseKind = "";
        string defaultSummaryLevel = "ultra";
        string defaultSummaryLanguage = "hebrew";
        List<string> enabledProviders = new List<string> { "ChatGPT", "Gemini", "Claude" };
        bool keepIntermediateTabs;
        long sequence;
        Thread thread;
        volatile bool running;
        volatile bool stopRequested;
        volatile bool browserReady;
        volatile string browserMessage = "";
        volatile string lastServerError = "";

        public int Port { get; private set; }
        public string Origin { get { return "http://127.0.0.1:" + Port; } }
        public string MobileOrigin
        {
            get { return mobileAddress == null ? "" : "http://" + mobileAddress + ":" + Port; }
        }
        public bool IsRunning { get { return running; } }
        public bool StopRequested { get { return stopRequested; } }
        public bool BrowserReady { get { return browserReady; } set { browserReady = value; } }
        public string BrowserMessage { get { return browserMessage; } set { browserMessage = value ?? ""; } }
        public bool HasQueuedJobs { get { lock (gate) { return jobs.Any(j => j.State == "queued"); } } }
        public bool HasPendingTitleLookups
        {
            get { lock (gate) { return jobs.Any(NeedsMetadataLookup); } }
        }
        public int MaxConcurrent { get { return maxConcurrent; } }
        public int StartIntervalMilliseconds { get { return startIntervalMilliseconds; } }
        public string LastServerError { get { return lastServerError; } }
        public bool DispatchPaused { get { lock (gate) { return dispatchPaused; } } }
        public string PauseReason { get { lock (gate) { return pauseReason; } } }
        public string PauseKind { get { lock (gate) { return pauseKind; } } }
        public string DefaultSummaryLevel { get { lock (gate) { return defaultSummaryLevel; } } }
        public string DefaultSummaryLanguage { get { lock (gate) { return defaultSummaryLanguage; } } }
        public string[] EnabledProviders { get { lock (gate) { return enabledProviders.ToArray(); } } }
        public bool KeepIntermediateTabs { get { lock (gate) { return keepIntermediateTabs; } } }
        // The helper replays every leftover pending-send journal on startup and recreates the job
        // it names, so removing a job has to remove its journal too or the job comes straight back
        // on the next restart. The journal lives outside the job state directory, so the host
        // process tells the server where it is.
        public string PendingSendDirectory
        {
            get { lock (gate) { return pendingSendDirectory; } }
            set { lock (gate) { pendingSendDirectory = value; } }
        }

        public LocalServer(int port, string secret, string page, string appScript)
            : this(port, secret, page, appScript, 20, 2000, null) { }

        public LocalServer(int port, string secret, string page, string appScript,
            int concurrency, int staggerMilliseconds, string storageDirectory)
            : this(port, secret, page, appScript, concurrency, staggerMilliseconds, storageDirectory, null) { }

        public LocalServer(int port, string secret, string page, string appScript,
            int concurrency, int staggerMilliseconds, string storageDirectory, string kiwiAddress)
        {
            if (secret == null || !Regex.IsMatch(secret, "^[a-f0-9]{64}$"))
                throw new ArgumentException("A 256-bit authorization token is required.");
            token = secret;
            html = page;
            script = appScript;
            if (concurrency < 1 || concurrency > 20 || staggerMilliseconds < 0)
                throw new ArgumentException("Invalid concurrency or start interval.");
            maxConcurrent = concurrency;
            startIntervalMilliseconds = staggerMilliseconds;
            stateDirectory = storageDirectory;
            if (!String.IsNullOrEmpty(kiwiAddress))
            {
                IPAddress parsed;
                if (!IPAddress.TryParse(kiwiAddress, out parsed) ||
                    parsed.AddressFamily != AddressFamily.InterNetwork || !IsPrivateAddress(parsed))
                    throw new ArgumentException("Kiwi access requires a private IPv4 address.");
                mobileAddress = parsed.ToString();
            }
            listener = new TcpListener(mobileAddress == null ? IPAddress.Loopback : IPAddress.Any, port);
            if (stateDirectory != null)
            {
                Directory.CreateDirectory(stateDirectory);
                LoadSettings();
                LoadScheduler();
                JavaScriptSerializer json = new JavaScriptSerializer();
                foreach (string path in Directory.GetFiles(stateDirectory, "*.json"))
                {
                    Job job = json.Deserialize<Job>(File.ReadAllText(path));
                    if (job == null || !ValidGuid(job.Id) || !ValidGuid(job.RequestId) ||
                        !Regex.IsMatch(job.VideoId ?? "", "^[A-Za-z0-9_-]{11}$") ||
                        job.DurationSeconds < 0 ||
                        (!String.IsNullOrEmpty(job.AmbiguousTargetId) &&
                            (job.AmbiguousTargetId.Length > 200 || !Regex.IsMatch(job.AmbiguousTargetId, @"\A[A-Za-z0-9_.:-]+\z"))) ||
                        (!String.IsNullOrEmpty(job.AmbiguousTextSha256) && !Regex.IsMatch(job.AmbiguousTextSha256, @"\A[0-9a-f]{64}\z")) ||
                        Path.GetFileNameWithoutExtension(path) != job.Id ||
                        !ValidState(job.State) || (!String.IsNullOrEmpty(job.ResultUrl) && !ValidResultUrl(job.ResultUrl)) ||
                        (job.PartResultUrls != null && job.PartResultUrls.Any(url => !ValidResultUrl(url))) ||
                        (!String.IsNullOrEmpty(job.SummaryLevel) && job.SummaryLevel != "legacy" && !ValidSummaryLevel(job.SummaryLevel)) ||
                        (!String.IsNullOrEmpty(job.SummaryLanguage) && !ValidSummaryLanguage(job.SummaryLanguage)) ||
                        jobs.Any(j => j.Id == job.Id || j.RequestId == job.RequestId))
                        throw new InvalidOperationException("Invalid saved job: " + Path.GetFileName(path));
                    if (job.PartResultUrls == null) job.PartResultUrls = new List<string>();
                    if (String.IsNullOrEmpty(job.SummaryLevel)) job.SummaryLevel = "legacy";
                    if (String.IsNullOrEmpty(job.SummaryLanguage)) job.SummaryLanguage = "hebrew";
                    if (job.SummaryLanguage != "hebrew")
                    {
                        job.SummaryLanguage = "hebrew";
                        job.UpdatedAt = DateTime.UtcNow;
                        Persist(job);
                    }

                    if (!String.IsNullOrEmpty(job.FinalResult))
                    {
                        string resultPath = Path.Combine(stateDirectory, job.Id + ".result.txt");
                        if (job.FinalResult != "local") throw new InvalidOperationException("Invalid saved full result: " + Path.GetFileName(path));
                        if (!File.Exists(resultPath))
                        {
                            job.FinalResult = "";
                            job.UpdatedAt = DateTime.UtcNow;
                            Persist(job);
                        }
                    }
                    string transcriptCache = TranscriptCachePath(job.Id);
                    job.TranscriptSaved = (transcriptCache != null && File.Exists(transcriptCache)) || !String.IsNullOrEmpty(job.FinalResult);
                    if (!Terminal(job) && job.State != "queued")
                    {
                        bool partial = job.State == "summarizing" || job.State == "combining" || job.State == "paused";
                        bool uncertain = job.State == "sending" || partial;
                        job.State = uncertain ? "error" : "cancelled";
                        job.Message = partial ? "The helper stopped during a multi-step summary. Partial conversations remain in browser history; retry uses the saved checkpoint."
                            : uncertain ? "The helper stopped during a send. The next retry reconciles the conversation before resending."
                            : "The helper stopped before finishing this video. No chunks are replayed automatically; check its ChatGPT history before using the bookmark again.";
                        ScheduleAutoRetry(job);
                        job.UpdatedAt = DateTime.UtcNow;
                        Persist(job);
                    }
                    jobs.Add(job);
                    sequence = Math.Max(sequence, job.Sequence);
                }
                jobs.Sort((a, b) => a.Sequence.CompareTo(b.Sequence));
                // Nothing dispatches automatically after a restart. Any video that was still
                // merely "queued" from a previous run would otherwise be picked up by TakeJob()
                // as soon as the browser is ready, with no user action at all; pausing dispatch
                // here requires an explicit click on Resume before anything (old or new) starts.
                if (!dispatchPaused && jobs.Any(j => j.State == "queued"))
                {
                    PauseDispatch("The helper restarted with already-queued videos. Nothing starts automatically; click Resume, or just add a video, when you want them to run.", "restart");
                }
            }
        }

        static bool IsPrivateAddress(IPAddress address)
        {
            byte[] octets = address.GetAddressBytes();
            return octets.Length == 4 &&
                (octets[0] == 10 ||
                 (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
                 (octets[0] == 192 && octets[1] == 168));
        }

        bool AllowedHost(string value)
        {
            if (value == "127.0.0.1:" + Port) return true;
            return mobileAddress != null && value == mobileAddress + ":" + Port;
        }

        string RequestOrigin(string host)
        {
            return "http://" + host;
        }

        public void Start()
        {
            listener.Start(64);
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            running = true;
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Start();
        }

        void Run()
        {
            try
            {
                while (running)
                {
                    using (TcpClient client = listener.AcceptTcpClient())
                    {
                        client.ReceiveTimeout = 4000;
                        client.SendTimeout = 4000;
                        try { Handle(client); }
                        catch (IOException ex) { lastServerError = "Local client disconnected or timed out: " + ex.Message; }
                        catch (SocketException ex) { lastServerError = "Local socket error: " + ex.Message; }
                    }
                }
            }
            catch (SocketException ex)
            {
                if (running) lastServerError = "Local listener failed: " + ex.Message;
            }
            catch (Exception ex)
            {
                // An unexpected server failure is fatal and surfaced to the controller.
                lastServerError = "Local server failed: " + ex.Message;
            }
            finally
            {
                running = false;
                listener.Stop();
            }
        }

        static string ReadLine(NetworkStream stream, ref int remaining)
        {
            List<byte> bytes = new List<byte>();
            while (true)
            {
                if (--remaining < 0) throw new HttpError(431, "Request headers are too large.");
                int value = stream.ReadByte();
                if (value < 0) throw new IOException("Incomplete HTTP request.");
                if (value == 10)
                {
                    if (bytes.Count == 0 || bytes[bytes.Count - 1] != 13)
                        throw new HttpError(400, "CRLF is required.");
                    bytes.RemoveAt(bytes.Count - 1);
                    return Encoding.ASCII.GetString(bytes.ToArray());
                }
                if (value > 126 || (value < 32 && value != 13 && value != 9))
                    throw new HttpError(400, "Invalid HTTP header.");
                bytes.Add((byte)value);
            }
        }

        static bool EqualToken(string actual, string expected)
        {
            if (actual == null || actual.Length != expected.Length) return false;
            int difference = 0;
            for (int i = 0; i < actual.Length; ++i) difference |= actual[i] ^ expected[i];
            return difference == 0;
        }

        static string Header(Dictionary<string, string> headers, string name)
        {
            string value;
            return headers.TryGetValue(name, out value) ? value : null;
        }

        static bool Terminal(Job job)
        {
            return job.State == "submitted" || job.State == "completed" || job.State == "error" || job.State == "needs-review" ||
                job.State == "reviewed" || job.State == "cancelled";
        }

        static bool ValidGuid(string value)
        {
            Guid parsed;
            return Guid.TryParseExact(value, "D", out parsed);
        }

        static bool ValidState(string state)
        {
            return new [] { "queued", "starting", "loading", "verification", "waiting-composer",
                "chatgpt", "gemini", "claude", "inserting", "sending", "submitted", "error", "needs-review",
                "reviewed", "cancelled", "splitting", "summarizing", "combining", "paused", "completed" }.Contains(state);
        }

        static bool ValidResultUrl(string url)
        {
            return url != null && Regex.IsMatch(url,
                @"\Ahttps://(?:chatgpt\.com/c/[A-Za-z0-9_-]+|gemini\.google\.com/app/[A-Za-z0-9_-]+|claude\.ai/chat/[A-Za-z0-9_-]+)\z");
        }

        static bool ValidSummaryLevel(string level)
        {
            return new [] { "ultra", "max", "reg", "min", "micro", "full" }.Contains(level);
        }

        static bool ValidSummaryLanguage(string language)
        {
            return new [] { "auto", "hebrew", "english" }.Contains(language);
        }

        static bool ValidStringFields(string body, int count)
        {
            const string value = @"""(?:[^""\\\x00-\x1f]|\\(?:[""\\/bfnrt]|u[0-9a-fA-F]{4}))*""";
            string field = value + @"[ \t\r\n]*:[ \t\r\n]*" + value;
            Match match = Regex.Match(body, @"\A[ \t\r\n]*\{[ \t\r\n]*(?<field>" + field +
                @")[ \t\r\n]*(?:,[ \t\r\n]*(?<field>" + field + @")[ \t\r\n]*)*\}[ \t\r\n]*\z");
            return match.Success && match.Groups["field"].Captures.Count == count;
        }

        static bool ValidJobFields(string body, int count)
        {
            const string text = @"""(?:[^""\\\x00-\x1f]|\\(?:[""\\/bfnrt]|u[0-9a-fA-F]{4}))*""";
            string field = text + @"[ \t\r\n]*:[ \t\r\n]*(?:" + text + @"|true|false)";
            Match match = Regex.Match(body, @"\A[ \t\r\n]*\{[ \t\r\n]*(?<field>" + field +
                @")[ \t\r\n]*(?:,[ \t\r\n]*(?<field>" + field + @")[ \t\r\n]*)*\}[ \t\r\n]*\z");
            return match.Success && match.Groups["field"].Captures.Count == count;
        }

        static bool TryGetEnabledProviders(object value, out List<string> providers)
        {
            providers = new List<string>();
            System.Collections.IEnumerable values = value as System.Collections.IEnumerable;
            if (values == null || value is string) return false;
            string[] order = { "ChatGPT", "Gemini", "Claude" };
            foreach (object item in values)
            {
                string provider = item as string;
                if (provider == null || !order.Contains(provider) || providers.Contains(provider)) return false;
                providers.Add(provider);
            }
            if (providers.Count == 0) return false;
            providers = order.Where(providers.Contains).ToList();
            return true;
        }

        static bool TryGetSettings(Dictionary<string, object> data, string body, out string level,
            out List<string> providers, out string language, out bool? keepIntermediateTabs, bool requireLevel)
        {
            level = null;
            providers = null;
            language = null;
            keepIntermediateTabs = null;
            if (data == null || data.Count < 1 || data.Count > 4 ||
                data.Keys.Any(key => key != "summaryLevel" && key != "enabledProviders" &&
                    key != "summaryLanguage" && key != "keepIntermediateTabs")) return false;
            object rawLevel;
            if (data.TryGetValue("summaryLevel", out rawLevel))
            {
                level = rawLevel as string;
                if (level == null || !ValidSummaryLevel(level) ||
                    Regex.Matches(body, @"""summaryLevel""[ \t\r\n]*:").Count != 1) return false;
            }
            else if (requireLevel) return false;
            object rawProviders;
            if (data.TryGetValue("enabledProviders", out rawProviders))
            {
                if (!TryGetEnabledProviders(rawProviders, out providers) ||
                    Regex.Matches(body, @"""enabledProviders""[ \t\r\n]*:").Count != 1) return false;
            }
            object rawLanguage;
            if (data.TryGetValue("summaryLanguage", out rawLanguage))
            {
                language = rawLanguage as string;
                if (language == null || !ValidSummaryLanguage(language) ||
                    Regex.Matches(body, @"""summaryLanguage""[ \t\r\n]*:").Count != 1) return false;
            }
            object rawKeepTabs;
            if (data.TryGetValue("keepIntermediateTabs", out rawKeepTabs))
            {
                if (!(rawKeepTabs is bool) ||
                    Regex.Matches(body, @"""keepIntermediateTabs""[ \t\r\n]*:").Count != 1) return false;
                keepIntermediateTabs = (bool)rawKeepTabs;
            }
            return level != null || providers != null || language != null || keepIntermediateTabs != null;
        }

        void LoadSettings()
        {
            string path = Path.Combine(stateDirectory, "settings.state");
            if (Directory.Exists(path)) throw new InvalidOperationException("Invalid saved settings.state: expected a file.");
            if (!File.Exists(path)) return;
            try
            {
                string body = File.ReadAllText(path);
                Dictionary<string, object> data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                string level;
                List<string> providers;
                string language;
                bool? keepTabs;
                if (!TryGetSettings(data, body, out level, out providers, out language, out keepTabs, true))
                    throw new InvalidOperationException("Expected a valid summaryLevel and optional non-empty enabledProviders / summaryLanguage / keepIntermediateTabs.");
                defaultSummaryLevel = level;
                if (providers != null) enabledProviders = providers;
                keepIntermediateTabs = keepTabs ?? false;
                // Older versions offered auto/English. Migrate those saved settings to the
                // Hebrew-only policy without rejecting the existing local settings file.
                defaultSummaryLanguage = "hebrew";
            }
            catch (Exception ex)
            {
                if (!(ex is IOException) && !(ex is UnauthorizedAccessException) &&
                    !(ex is ArgumentException) && !(ex is InvalidOperationException)) throw;
                throw new InvalidOperationException("Invalid saved settings.state: " + ex.Message, ex);
            }
        }

        void PersistSettings(string level, IEnumerable<string> providers, string language, bool keepTabs)
        {
            if (stateDirectory == null) return;
            PersistFile(Path.Combine(stateDirectory, "settings.state"),
                new JavaScriptSerializer().Serialize(new {
                    summaryLevel = level, enabledProviders = providers.ToArray(), summaryLanguage = language,
                    keepIntermediateTabs = keepTabs
                }), "summary settings");
        }

        void LoadScheduler()
        {
            string path = Path.Combine(stateDirectory, "scheduler.state");
            if (Directory.Exists(path)) throw new InvalidOperationException("Invalid saved scheduler.state: expected a file.");
            if (!File.Exists(path)) return;
            try
            {
                Dictionary<string, object> data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                object paused, reason, kind;
                // A state file written before pause kinds existed has two fields; it can only
                // describe a usage pause, which is the safest kind to assume.
                if (data == null || (data.Count != 2 && data.Count != 3) ||
                    !data.TryGetValue("paused", out paused) || !(paused is bool) ||
                    !data.TryGetValue("pauseReason", out reason) || !(reason is string) ||
                    ((bool)paused ? String.IsNullOrWhiteSpace((string)reason) : (string)reason != ""))
                    throw new InvalidOperationException("Invalid scheduler pause fields.");
                if (!data.TryGetValue("pauseKind", out kind)) kind = null;
                if (data.Count == 3 && !(kind is string)) throw new InvalidOperationException("Invalid scheduler pause fields.");
                string pausedKind = kind as string;
                if ((bool)paused && String.IsNullOrWhiteSpace(pausedKind)) pausedKind = "usage";
                if (!(bool)paused && !String.IsNullOrWhiteSpace(pausedKind))
                    throw new InvalidOperationException("Invalid scheduler pause fields.");
                if ((bool)paused && pausedKind != "usage" && pausedKind != "restart")
                    throw new InvalidOperationException("Invalid scheduler pause fields.");
                dispatchPaused = (bool)paused;
                pauseReason = (string)reason;
                pauseKind = dispatchPaused ? pausedKind : "";
                // Usage-limit pauses are no longer created: a provider rate-limit banner is
                // usually transient and provider-specific, and halting the whole queue behind
                // it was wrong far more often than it was right. A usage pause saved by an
                // older build must not strand the queue forever, so it is dropped on load.
                if (dispatchPaused && pauseKind == "usage")
                {
                    dispatchPaused = false;
                    pauseReason = "";
                    pauseKind = "";
                }
            }
            catch (Exception ex)
            {
                if (!(ex is IOException) && !(ex is UnauthorizedAccessException) &&
                    !(ex is ArgumentException) && !(ex is InvalidOperationException)) throw;
                throw new InvalidOperationException("Invalid saved scheduler.state: " + ex.Message, ex);
            }
        }

        void PersistScheduler(bool paused, string reason, string kind)
        {
            if (stateDirectory == null) return;
            string path = Path.Combine(stateDirectory, "scheduler.state");
            PersistFile(path, new JavaScriptSerializer().Serialize(new { paused = paused, pauseReason = reason, pauseKind = kind }), "scheduler state");
        }

        public void PauseForUsageLimit(string reason)
        {
            PauseDispatch(reason, "usage");
        }

        void PauseDispatch(string reason, string kind)
        {
            if (String.IsNullOrWhiteSpace(reason)) throw new ArgumentException("A usage-limit pause reason is required.");
            lock (gate)
            {
                PersistScheduler(true, reason, kind);
                dispatchPaused = true;
                pauseReason = reason;
                pauseKind = kind;
            }
        }

        public void ResumeDispatch()
        {
            lock (gate)
            {
                PersistScheduler(false, "", "");
                dispatchPaused = false;
                pauseReason = "";
                pauseKind = "";
            }
        }

        // The restart hold exists only because nothing should start on its own after a restart.
        // Any explicit "run this now" request from the user answers that question, so the hold is
        // released. A failure to persist that only leaves the hold in place for the Resume button.
        void ClearRestartHold()
        {
            lock (gate)
            {
                if (!dispatchPaused || pauseKind != "restart") return;
                ClearDispatchHold();
            }
        }

        // "Start now" names a specific video the user wants run, which answers any hold currently
        // on the scheduler, not just the restart one. A stale usage hold written by an older build
        // would otherwise keep the queue frozen with no control on the tile able to release it.
        void ClearDispatchHold()
        {
            lock (gate)
            {
                if (!dispatchPaused) return;
                try { ResumeDispatch(); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                catch (InvalidOperationException) { }
            }
        }

        void Persist(Job job)
        {
            if (stateDirectory == null) return;
            string path = Path.Combine(stateDirectory, job.Id + ".json");
            PersistFile(path, new JavaScriptSerializer().Serialize(job), "job " + job.Id);
        }

        string PartCheckpointPath(string jobId)
        {
            return stateDirectory == null ? null : Path.Combine(stateDirectory, jobId + ".parts.state");
        }

        public PartCheckpoint GetPartCheckpoint(string jobId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                string path = PartCheckpointPath(jobId);
                PartCheckpoint checkpoint;
                if (partCheckpoints.TryGetValue(jobId, out checkpoint)) return checkpoint;
                if (path == null || !File.Exists(path)) return null;
                try { checkpoint = new JavaScriptSerializer().Deserialize<PartCheckpoint>(File.ReadAllText(path)); }
                catch { return null; }
                if (checkpoint == null || checkpoint.Parts == null ||
                    checkpoint.Parts.Any(part => part == null || String.IsNullOrWhiteSpace(part.Text) ||
                        (!String.IsNullOrEmpty(part.ResultUrl) && !ValidResultUrl(part.ResultUrl))))
                    return null;
                partCheckpoints[jobId] = checkpoint;
                return checkpoint;
            }
        }

        public void ResetPartCheckpoint(string jobId, string transcriptHash, int transcriptLength,
            int chunkCount, string summaryLevel, string planHash, string providerName, int rotationCursor)
        {
            if (!Regex.IsMatch(transcriptHash ?? "", @"\A[0-9a-f]{64}\z") ||
                !Regex.IsMatch(planHash ?? "", @"\A[0-9a-f]{64}\z") ||
                transcriptLength < 1 || chunkCount < 1 ||
                (summaryLevel != "legacy" && !ValidSummaryLevel(summaryLevel)))
                throw new ArgumentException("Valid transcript checkpoint metadata is required.");
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                PartCheckpoint checkpoint = new PartCheckpoint {
                    TranscriptHash = transcriptHash, TranscriptLength = transcriptLength,
                    ChunkCount = chunkCount, SummaryLevel = summaryLevel, PlanHash = planHash,
                    Parts = new List<PartCheckpointEntry>()
                };
                partCheckpoints[jobId] = checkpoint;
                string path = PartCheckpointPath(jobId);
                if (path != null)
                    PersistFile(path, new JavaScriptSerializer().Serialize(checkpoint), "part checkpoint " + jobId);
                job.PartResultUrls = new List<string>();
                job.ProviderName = providerName;
                job.RotationCursor = rotationCursor;
                job.StageIndex = 0;
                job.SuccessfulParts = 0;
                job.TranscriptHash = transcriptHash;
                job.TranscriptLength = transcriptLength;
                job.ChunkCount = chunkCount;
                string transcriptPath = TranscriptCachePath(jobId);
                job.TranscriptSaved = (transcriptPath != null && File.Exists(transcriptPath)) || !String.IsNullOrEmpty(job.FinalResult);
                job.Progress = "Prepared transcript and " + chunkCount + " stage(s).";
                job.UpdatedAt = DateTime.UtcNow;
                Persist(job);
            }
        }

        public void SavePartCheckpoint(string jobId, int index, string text, string resultUrl,
            string providerName, int rotationCursor)
        {
            if (index < 0 || String.IsNullOrWhiteSpace(text) ||
                (!String.IsNullOrEmpty(resultUrl) && !ValidResultUrl(resultUrl)))
                throw new ArgumentException("Valid sequential part checkpoint data is required.");
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                PartCheckpoint checkpoint = GetPartCheckpoint(jobId);
                if (checkpoint == null || checkpoint.Parts.Count != index)
                    throw new InvalidOperationException("Part checkpoint index is not sequential.");
                checkpoint.Parts.Add(new PartCheckpointEntry {
                    Text = text, ResultUrl = resultUrl ?? "", ProviderName = providerName ?? ""
                });
                partCheckpoints[jobId] = checkpoint;
                string path = PartCheckpointPath(jobId);
                if (path != null)
                    PersistFile(path, new JavaScriptSerializer().Serialize(checkpoint), "part checkpoint " + jobId);
                if (!String.IsNullOrEmpty(resultUrl) && !job.PartResultUrls.Contains(resultUrl))
                    job.PartResultUrls.Add(resultUrl);
                job.ProviderName = providerName;
                job.RotationCursor = rotationCursor;
                job.StageIndex = index + 1;
                job.SuccessfulParts = index + 1;
                string transcriptPath = TranscriptCachePath(jobId);
                job.TranscriptSaved = (transcriptPath != null && File.Exists(transcriptPath)) || !String.IsNullOrEmpty(job.FinalResult);
                job.Progress = "Completed Part " + (index + 1) + "/" + checkpoint.ChunkCount + ".";
                job.UpdatedAt = DateTime.UtcNow;
                Persist(job);
            }
        }

        string TranscriptCachePath(string jobId)
        {
            // The transcript is kept beside the part checkpoint so a restart can resume a
            // half-finished video without calling the transcript service again. Both files
            // share one lifetime and are deleted together the moment the video finishes or
            // its progress is cleared, so nothing is retained for a completed video.
            return stateDirectory == null ? null : Path.Combine(stateDirectory, jobId + ".transcript.state");
        }

        public string GetTranscriptCache(string jobId, string videoId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                string path = TranscriptCachePath(jobId);
                if (path == null || !File.Exists(path)) return null;
                TranscriptCache cache;
                try { cache = new JavaScriptSerializer().Deserialize<TranscriptCache>(File.ReadAllText(path)); }
                catch { return null; }
                // A cached transcript is only ever reused for the very video it was read
                // for, so a recycled job id can never mix two videos' transcripts.
                if (cache == null || String.IsNullOrEmpty(cache.Text) || cache.VideoId != videoId ||
                    cache.VideoId != job.VideoId)
                    return null;
                job.TranscriptSaved = true;
                return cache.Text;
            }
        }

        public void SaveTranscriptCache(string jobId, string videoId, string text)
        {
            if (String.IsNullOrWhiteSpace(text)) throw new ArgumentException("A transcript is required.");
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (job.VideoId != videoId) throw new ArgumentException("The transcript belongs to another video.");
                string path = TranscriptCachePath(jobId);
                if (path == null) return;
                PersistFile(path, new JavaScriptSerializer().Serialize(
                    new TranscriptCache { VideoId = videoId, Text = text }), "transcript cache " + jobId);
                job.TranscriptSaved = true;
                job.UpdatedAt = DateTime.UtcNow;
                Persist(job);
            }
        }

        void DeletePartCheckpoint(string jobId)
        {
            partCheckpoints.Remove(jobId);
            string path = PartCheckpointPath(jobId);
            if (path != null) DeleteFileWithRetry(path, "part checkpoint");
            string transcriptPath = TranscriptCachePath(jobId);
            if (transcriptPath != null) DeleteFileWithRetry(transcriptPath, "transcript cache");
            Job job = jobs.Find(j => j.Id == jobId);
            if (job != null)
            {
                job.TranscriptSaved = !String.IsNullOrEmpty(job.FinalResult);
            }
        }

        public void CompletePartCheckpoint(string jobId)
        {
            lock (gate)
            {
                if (jobs.Find(j => j.Id == jobId) == null) throw new InvalidOperationException("Unknown job.");
                DeletePartCheckpoint(jobId);
            }
        }

        static void PersistFile(string path, string content, string description)
        {
            string temporary = path + ".tmp";
            byte[] bytes = Encoding.UTF8.GetBytes(content);
            try
            {
                for (int attempt = 0; ; attempt++)
                {
                    try
                    {
                        using (FileStream file = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            file.Write(bytes, 0, bytes.Length);
                            file.Flush(true);
                        }
                        if (File.Exists(path)) File.Replace(temporary, path, null);
                        else File.Move(temporary, path);
                        return;
                    }
                    catch (IOException ex)
                    {
                        int code = ex.HResult & 0xffff;
                        // These Windows lock errors leave the destination unchanged; never delete it to force a save.
                        if (attempt >= 5 || (code != 32 && code != 33 && code != 1175)) throw;
                        Thread.Sleep(50 << attempt);
                    }
                }
            }
            catch (IOException ex) { throw new InvalidOperationException("Could not persist " + description + ": " + ex.Message, ex); }
            catch (UnauthorizedAccessException ex) { throw new InvalidOperationException("Could not persist " + description + ": " + ex.Message, ex); }
        }

        static void DeleteFileWithRetry(string path, string description)
        {
            try
            {
                for (int attempt = 0; ; attempt++)
                {
                    try
                    {
                        if (File.Exists(path)) File.Delete(path);
                        return;
                    }
                    catch (IOException ex)
                    {
                        int code = ex.HResult & 0xffff;
                        if (attempt >= 5 || (code != 32 && code != 33)) throw;
                        Thread.Sleep(50 << attempt);
                    }
                }
            }
            catch (IOException ex) { throw new InvalidOperationException("Could not remove " + description + ": " + ex.Message, ex); }
            catch (UnauthorizedAccessException ex) { throw new InvalidOperationException("Could not remove " + description + ": " + ex.Message, ex); }
        }

        public Job GetJob(string id)
        {
            lock (gate) { return jobs.Find(j => j.Id == id); }
        }

        void RemoveJobFiles(Job job, string description)
        {
            // Every on-disk trace of one job is removed together. Leaving the pending-send
            // journal behind would let the next startup replay it and recreate this job.
            if (stateDirectory != null)
            {
                DeleteFileWithRetry(Path.Combine(stateDirectory, job.Id + ".result.txt"), description + " full transcript result");
                DeleteFileWithRetry(Path.Combine(stateDirectory, job.Id + ".parts.state"), description + " part checkpoint");
                DeleteFileWithRetry(Path.Combine(stateDirectory, job.Id + ".transcript.state"), description + " transcript cache");
                DeleteFileWithRetry(Path.Combine(stateDirectory, job.Id + ".json"), description + " job " + job.Id);
            }
            if (pendingSendDirectory != null)
                DeleteFileWithRetry(Path.Combine(pendingSendDirectory, job.Id + ".json"), description + " pending-send journal " + job.Id);
        }

        public Job RestorePendingSend(string id, string requestId, string videoId)
        {
            lock (gate)
            {
                if (!ValidGuid(id) || !ValidGuid(requestId) || !Regex.IsMatch(videoId ?? "", "^[A-Za-z0-9_-]{11}$"))
                    throw new ArgumentException("Invalid pending-send record.");
                Job job = jobs.Find(j => j.Id == id || j.RequestId == requestId);
                if (job == null)
                {
                    job = new Job { Id = id, RequestId = requestId, VideoId = videoId, SummaryLevel = "legacy", SummaryLanguage = "hebrew",
                        ProviderName = "ChatGPT", RotationCursor = 0, StageIndex = 0, Progress = "", RetryReason = "",
                        PartResultUrls = new List<string>(),
                        CreatedAt = DateTime.UtcNow, Sequence = ++sequence };
                    jobs.Add(job);
                }
                if (job.Id != id || job.RequestId != requestId || job.VideoId != videoId)
                    throw new InvalidOperationException("Pending-send record conflicts with saved job.");
                // A journal is only evidence that a send was interrupted, never evidence that the
                // video failed. A video that already finished keeps its result: without this a
                // leftover journal resurrects it as a failure on every single launch, because
                // nothing else ever consumes the file once the job is done.
                if (job.State == "completed" || job.State == "submitted") return null;
                job.State = "error";
                job.Message = "An ambiguous legacy send will be automatically resent on retry; duplicate risk is recorded.";
                ScheduleAutoRetry(job);
                job.UpdatedAt = DateTime.UtcNow;
                Persist(job);
                return job;
            }
        }

        public Job TakeReviewAcknowledgement()
        {
            lock (gate)
            {
                if (acknowledgements.Count == 0) return null;
                string id = acknowledgements.Dequeue();
                return jobs.Find(j => j.Id == id);
            }
        }

        public void CompleteReview(string id)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == id);
                if (job == null || job.State != "needs-review") throw new InvalidOperationException("Unknown pending review.");
                UpdateJob(id, "reviewed", "The previous send was reviewed. This video can be submitted again if needed.");
                acknowledgementIds.Remove(id);
            }
        }

        public Job TakeJob()
        {
            lock (gate)
            {
                if (!browserReady || stopRequested || dispatchPaused || DateTime.UtcNow < nextStart ||
                    jobs.Count(j => !Terminal(j) && j.State != "queued") >= maxConcurrent) return null;
                // A job set aside with "Watch later" stays in state "queued" (so it is not
                // silently retried/cleared like a cancelled job) but must never be dispatched
                // automatically until the user explicitly un-marks it.
                Job job = jobs.Find(j => j.State == "queued" && !j.WatchLater);
                if (job == null) return null;
                UpdateJob(job.Id, "starting", "Starting this video's isolated worker.");
                nextStart = DateTime.UtcNow.AddMilliseconds(startIntervalMilliseconds);
                return job;
            }
        }

        public Job TakeTitleLookup()
        {
            lock (gate)
            {
                if (!browserReady || stopRequested) return null;
                Job job = jobs.FirstOrDefault(j => NeedsMetadataLookup(j) &&
                    !titleLookupInFlightIds.Contains(j.Id) &&
                    (!titleLookupRetryUtc.ContainsKey(j.Id) || titleLookupRetryUtc[j.Id] <= DateTime.UtcNow));
                if (job != null) titleLookupInFlightIds.Add(job.Id);
                return job;
            }
        }

        static bool NeedsTitleLookup(string title)
        {
            if (String.IsNullOrWhiteSpace(title)) return true;
            string normalized = Regex.Replace(title.Trim(), "\\s+", " ");
            return normalized.Equals("YouTube Transcript Generator | Extract & Download Video Transcripts",
                       StringComparison.OrdinalIgnoreCase) ||
                   normalized.Equals("YouTube Transcript Generator", StringComparison.OrdinalIgnoreCase) ||
                   normalized.Equals("Transcript Workspace — YouTube Transcript + AI",
                       StringComparison.OrdinalIgnoreCase);
        }

        static bool NeedsMetadataLookup(Job job)
        {
            return job != null && (NeedsTitleLookup(job.Title) || job.DurationSeconds <= 0);
        }

        public void CompleteTitleLookup(string id, bool succeeded)
        {
            lock (gate)
            {
                titleLookupInFlightIds.Remove(id);
                if (succeeded) titleLookupRetryUtc.Remove(id);
                else titleLookupRetryUtc[id] = DateTime.UtcNow.AddMinutes(5);
            }
        }

        public Job TakeAmbiguousReconcile()
        {
            lock (gate)
            {
                if (!browserReady || stopRequested) return null;
                Job job = jobs.FirstOrDefault(j => AmbiguousSendRecoverable(j) && HasAmbiguousSendMetadata(j) &&
                    !j.ReconcileAttempted && !reconcileInFlightIds.Contains(j.Id));
                if (job != null) reconcileInFlightIds.Add(job.Id);
                return job;
            }
        }

        public void CompleteAmbiguousReconcile(string id, bool reconciled)
        {
            CompleteAmbiguousReconcile(id, reconciled, false);
        }

        public void CompleteAmbiguousReconcile(string id, bool reconciled, bool retryLater)
        {
            lock (gate)
            {
                reconcileInFlightIds.Remove(id);
                if (reconciled) { reconcileDeferrals.Remove(id); return; }
                Job job = jobs.Find(j => j.Id == id);
                if (job == null || job.ReconcileAttempted || !AmbiguousSendRecoverable(job) ||
                    !HasAmbiguousSendMetadata(job)) return;
                if (retryLater)
                {
                    // A matching conversation that is still generating stays eligible, but only
                    // for a bounded number of sweeps so this can never spin forever.
                    int seen = reconcileDeferrals.ContainsKey(id) ? reconcileDeferrals[id] : 0;
                    reconcileDeferrals[id] = seen + 1;
                    if (seen + 1 < 12) return;
                }
                reconcileDeferrals.Remove(id);
                // A completed sweep that found no safe evidence is recorded once so the dashboard
                // can stop promising an automatic repair and offer the manual fallback instead.
                job.ReconcileAttempted = true;
                try { Persist(job); }
                catch { job.ReconcileAttempted = false; throw; }
            }
        }

        public void SetAmbiguousSend(string id, string targetId, string expectedTextSha256)
        {
            if (targetId != null && (targetId.Length > 200 || !Regex.IsMatch(targetId, @"\A[A-Za-z0-9_.:-]*\z")))
                throw new ArgumentException("An unexpected browser target id was supplied.");
            if (expectedTextSha256 != null && expectedTextSha256.Length > 0 &&
                !Regex.IsMatch(expectedTextSha256, @"\A[0-9a-f]{64}\z"))
                throw new ArgumentException("An unexpected prompt hash was supplied.");
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == id);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                string previousTarget = job.AmbiguousTargetId, previousHash = job.AmbiguousTextSha256;
                bool previousAttempted = job.ReconcileAttempted;
                job.AmbiguousTargetId = targetId ?? "";
                job.AmbiguousTextSha256 = expectedTextSha256 ?? "";
                job.ReconcileAttempted = false;
                try { Persist(job); }
                catch
                {
                    job.AmbiguousTargetId = previousTarget;
                    job.AmbiguousTextSha256 = previousHash;
                    job.ReconcileAttempted = previousAttempted;
                    throw;
                }
            }
        }

        public void UpdateJob(string id, string state, string message)
        {
            lock (gate)
            {
                if (!ValidState(state)) throw new ArgumentException("Unknown job state.");
                Job job = jobs.Find(j => j.Id == id);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (job.State == state && job.Message == message) return;
                string previousState = job.State, previousMessage = job.Message;
                DateTime previousUpdatedAt = job.UpdatedAt;
                DateTime previousAutoRetryAfter = job.AutoRetryAfterUtc;
                int previousAutoRetryAttempts = job.AutoRetryAttempts;
                bool wasReported = failureReportIds.Contains(id);
                job.State = state;
                job.Message = message;
                job.UpdatedAt = DateTime.UtcNow;
                // A stage failure is reported as "error" while the worker is still rotating to
                // the next provider, so the automatic retry is only ever scheduled, never run
                // from here. The host loop additionally refuses to touch a job whose worker is
                // still alive, and the delay lets those in-worker transitions settle first.
                if (state == "error") ScheduleAutoRetry(job);
                else if (state == "completed" || state == "submitted") { job.AutoRetryAttempts = 0; job.AutoRetryAfterUtc = DateTime.MinValue; }
                if (state != "error") failureReportIds.Remove(id);
                try { Persist(job); }
                catch
                {
                    job.State = previousState;
                    job.Message = previousMessage;
                    job.UpdatedAt = previousUpdatedAt;
                    job.AutoRetryAfterUtc = previousAutoRetryAfter;
                    job.AutoRetryAttempts = previousAutoRetryAttempts;
                    if (wasReported) failureReportIds.Add(id);
                    throw;
                }
            }
        }

        public const int MaxAutoRetryAttempts = 3;

        static TimeSpan AutoRetryDelay(int attempts)
        {
            if (attempts <= 0) return TimeSpan.FromSeconds(30);
            return attempts == 1 ? TimeSpan.FromMinutes(2) : TimeSpan.FromMinutes(5);
        }

        // Every transition into "error" schedules the automatic repair, wherever it comes from:
        // a worker, the restart migration, or a replayed pending-send journal. Without this a
        // failure restored at startup would sit forever waiting for a manual click.
        static void ScheduleAutoRetry(Job job)
        {
            job.AutoRetryAfterUtc = DateTime.UtcNow.Add(AutoRetryDelay(job.AutoRetryAttempts));
        }

        // A failure the user never asked for should not sit waiting for a manual click. Anything
        // the user decided themselves (stop, pause, watch later) and anything already retried to
        // its cap is excluded, so this can never loop and never overrides an explicit choice.
        static bool AutoRetryEligible(Job job)
        {
            return job != null && job.State == "error" && !job.PausedByUser && !job.WatchLater &&
                job.AutoRetryAttempts < MaxAutoRetryAttempts;
        }

        public Job TakeAutoRetryCandidate()
        {
            lock (gate)
            {
                if (!browserReady || stopRequested || dispatchPaused) return null;
                return jobs.FirstOrDefault(j => AutoRetryEligible(j) &&
                    j.AutoRetryAfterUtc != DateTime.MinValue && j.AutoRetryAfterUtc <= DateTime.UtcNow);
            }
        }

        // A video that used up its automatic attempts is reported once so the failure is still
        // captured for investigation even though nothing further will be tried on its own.
        public Job TakeUnrecordedFailure()
        {
            lock (gate)
            {
                if (stopRequested) return null;
                return jobs.FirstOrDefault(j => j.State == "error" && !j.PausedByUser &&
                    j.AutoRetryAttempts >= MaxAutoRetryAttempts && !failureReportIds.Contains(j.Id));
            }
        }

        public void MarkFailureRecorded(string id)
        {
            lock (gate) { failureReportIds.Add(id); }
        }

        public Job RequeueForAutoRetry(string jobId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (!AutoRetryEligible(job)) throw new InvalidOperationException("This video is not eligible for an automatic retry.");
                int attempt = job.AutoRetryAttempts + 1;
                string previousState = job.State, previousMessage = job.Message, previousReason = job.RetryReason;
                DateTime previousUpdatedAt = job.UpdatedAt, previousAfter = job.AutoRetryAfterUtc;
                job.AutoRetryAttempts = attempt;
                job.AutoRetryAfterUtc = DateTime.MinValue;
                job.State = "queued";
                job.RetryReason = previousMessage ?? "";
                job.Message = "Retrying automatically from the saved checkpoint (attempt " + attempt +
                    " of " + MaxAutoRetryAttempts + ").";
                job.UpdatedAt = DateTime.UtcNow;
                try { Persist(job); }
                catch
                {
                    job.AutoRetryAttempts = attempt - 1;
                    job.AutoRetryAfterUtc = previousAfter;
                    job.State = previousState;
                    job.Message = previousMessage;
                    job.RetryReason = previousReason;
                    job.UpdatedAt = previousUpdatedAt;
                    throw;
                }
                ClearRestartHold();
                return job;
            }
        }

        public void SetJobTitle(string id, string title)
        {
            SetJobMetadata(id, title, 0);
        }

        public void SetJobMetadata(string id, string title, int durationSeconds)
        {
            title = (title ?? "").Trim();
            if (durationSeconds < 0) throw new ArgumentException("Invalid video metadata.");
            if (title.Length > 300) title = "";
            if (title.Length == 0 && durationSeconds == 0) return;
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == id);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                string nextTitle = title.Length > 0 ? title : job.Title;
                int nextDuration = durationSeconds > 0 ? durationSeconds : job.DurationSeconds;
                if (job.Title == nextTitle && job.DurationSeconds == nextDuration) return;
                string previousTitle = job.Title;
                int previousDuration = job.DurationSeconds;
                DateTime previousUpdatedAt = job.UpdatedAt;
                job.Title = nextTitle;
                job.DurationSeconds = nextDuration;
                job.UpdatedAt = DateTime.UtcNow;
                try { Persist(job); }
                catch
                {
                    job.Title = previousTitle;
                    job.DurationSeconds = previousDuration;
                    job.UpdatedAt = previousUpdatedAt;
                    throw;
                }
            }
        }

        public void SetResultUrl(string jobId, string url)
        {
            if (!ValidResultUrl(url)) throw new ArgumentException("A canonical supported-provider conversation URL is required.");
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (job.ResultUrl == url) return;
                string previousUrl = job.ResultUrl;
                DateTime previousUpdatedAt = job.UpdatedAt;
                job.ResultUrl = url;
                job.UpdatedAt = DateTime.UtcNow;
                try { Persist(job); }
                catch
                {
                    job.ResultUrl = previousUrl;
                    job.UpdatedAt = previousUpdatedAt;
                    throw;
                }
            }
        }

        public void AddPartResultUrl(string jobId, string url)
        {
            // Records one split/hierarchical part's own conversation link so the dashboard can
            // reopen every part later, even after its tab was closed. Merge-round stages are not
            // recorded here; only the initial chunk stages the dashboard already counts as "Parts".
            if (!ValidResultUrl(url)) throw new ArgumentException("A canonical supported-provider conversation URL is required.");
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (job.PartResultUrls == null) job.PartResultUrls = new List<string>();
                if (job.PartResultUrls.Contains(url)) return;
                List<string> previous = new List<string>(job.PartResultUrls);
                DateTime previousUpdatedAt = job.UpdatedAt;
                job.PartResultUrls.Add(url);
                job.UpdatedAt = DateTime.UtcNow;
                try { Persist(job); }
                catch
                {
                    job.PartResultUrls = previous;
                    job.UpdatedAt = previousUpdatedAt;
                    throw;
                }
            }
        }

        public void ClearJobPartResultUrls(string jobId)
        {
            // Every fresh run of a video (a brand-new dispatch after "Retry from checkpoint", or
            // any restart) re-fetches the transcript and re-sends every part from scratch, and
            // already resets StageIndex/SuccessfulParts back to 0 for that new run. PartResultUrls
            // must be reset at that exact same moment, otherwise it silently keeps accumulating
            // conversation links left over from earlier, now-abandoned attempts, making "Open all
            // parts" show more/older links than the "Parts: N/M" counter for the current run.
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (job.PartResultUrls == null || job.PartResultUrls.Count == 0) return;
                List<string> previous = job.PartResultUrls;
                DateTime previousUpdatedAt = job.UpdatedAt;
                job.PartResultUrls = new List<string>();
                job.UpdatedAt = DateTime.UtcNow;
                try { Persist(job); }
                catch
                {
                    job.PartResultUrls = previous;
                    job.UpdatedAt = previousUpdatedAt;
                    throw;
                }
            }
        }

        static bool AmbiguousSendRecoverable(Job job)
        {
            // Any error/needs-review job with no captured result link may have actually finished
            // in its provider conversation; the user can attach that link manually as a safety
            // net regardless of what the specific failure message says.
            if (job == null || !String.IsNullOrEmpty(job.ResultUrl)) return false;
            return job.State == "error" || job.State == "needs-review";
        }

        static bool HasAmbiguousSendMetadata(Job job)
        {
            // The automatic browser sweep can only safely match a conversation using the exact
            // tab id or prompt hash captured at send time, so it must stay narrower than the
            // manual attach button: only jobs with that metadata are worth sweeping for.
            return job != null &&
                (!String.IsNullOrEmpty(job.AmbiguousTargetId) || !String.IsNullOrEmpty(job.AmbiguousTextSha256));
        }

        public Job AttachJobResult(string jobId, string url)
        {
            return AttachJobResult(jobId, url, false);
        }

        public Job AttachJobResult(string jobId, string url, bool automatic)
        {
            if (!ValidResultUrl(url))
                throw new ArgumentException("A canonical supported-provider conversation URL is required.");
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (!AmbiguousSendRecoverable(job))
                    throw new InvalidOperationException("Only an ambiguous send with no saved result link can be reconciled this way.");
                string previousUrl = job.ResultUrl, previousState = job.State, previousMessage = job.Message;
                DateTime previousUpdatedAt = job.UpdatedAt;
                job.ResultUrl = url;
                job.State = "completed";
                job.Message = automatic
                    ? "Recovered automatically: the summary was found finished in its provider conversation."
                    : "Reconciled locally: you attached the final summary conversation for this ambiguous send.";
                job.UpdatedAt = DateTime.UtcNow;
                try { Persist(job); }
                catch
                {
                    job.ResultUrl = previousUrl;
                    job.State = previousState;
                    job.Message = previousMessage;
                    job.UpdatedAt = previousUpdatedAt;
                    throw;
                }
                return job;
            }
        }

        public void SetFinalResult(string jobId, string text)
        {
            if (String.IsNullOrEmpty(text) || text.Length > 4000000)
                throw new ArgumentException("A non-empty local result within the safety limit is required.");
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (stateDirectory == null)
                {
                    job.FinalResult = text;
                    return;
                }
                PersistFile(Path.Combine(stateDirectory, job.Id + ".result.txt"), text, "full transcript result");
                string previous = job.FinalResult;
                DateTime previousUpdatedAt = job.UpdatedAt;
                job.FinalResult = "local";
                job.TranscriptSaved = true;
                job.UpdatedAt = DateTime.UtcNow;
                try { Persist(job); }
                catch
                {
                    job.FinalResult = previous;
                    job.UpdatedAt = previousUpdatedAt;
                    throw;
                }
            }
        }

        public string GetFinalResult(string jobId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null || String.IsNullOrEmpty(job.FinalResult))
                    throw new InvalidOperationException("This job has no saved local result.");
                if (stateDirectory == null) return job.FinalResult;
                if (job.FinalResult != "local") throw new InvalidOperationException("Invalid local result marker.");
                return File.ReadAllText(Path.Combine(stateDirectory, job.Id + ".result.txt"));
            }
        }

        public Job RetryJob(string jobId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (job.State != "error" && job.State != "cancelled" && job.State != "needs-review")
                    throw new InvalidOperationException("Only a stopped or failed video can be retried.");
                bool wasWatchLater = job.WatchLater;
                job.State = "queued";
                job.Message = wasWatchLater
                    ? "Retrying from its saved checkpoint. Removed from Watch later so it can actually run."
                    : "Retrying from its saved checkpoint.";
                job.RetryReason = "";
                job.PausedByUser = false;
                // Every user-owned hold is released, not just Pause. TakeJob deliberately skips a
                // Watch later video, so leaving the flag set parked the job in "queued" for ever
                // while it advertised "Retrying from its saved checkpoint" and never started.
                job.WatchLater = false;
                // An explicit retry is a fresh decision by the user, so the automatic attempts
                // budget starts over rather than staying exhausted from an earlier failure.
                job.AutoRetryAttempts = 0;
                job.AutoRetryAfterUtc = DateTime.MinValue;
                job.UpdatedAt = DateTime.UtcNow;
                Persist(job);
                ClearRestartHold();
                return job;
            }
        }

        // Every hold that can keep a video out of TakeJob at once: the Watch later flag, the
        // per-video pause, a failed state, and the scheduler's restart hold. Removing Watch later
        // alone left the restart hold in place, so a queued video still never ran and the tile
        // offered nothing else to click.
        public Job StartJobNow(string jobId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (job.State == "completed" || job.State == "submitted")
                    throw new InvalidOperationException("This video already finished; there is nothing to start.");
                job.State = "queued";
                job.Message = "Starting now at your request; it runs as soon as a provider slot is free.";
                job.RetryReason = "";
                job.PausedByUser = false;
                job.WatchLater = false;
                job.AutoRetryAttempts = 0;
                job.AutoRetryAfterUtc = DateTime.MinValue;
                job.UpdatedAt = DateTime.UtcNow;
                Persist(job);
                ClearDispatchHold();
                return job;
            }
        }

        public void StopJob(string jobId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (Terminal(job)) throw new InvalidOperationException("This video already finished; there is nothing to stop.");
                if (job.State == "queued")
                {
                    // No worker has started yet; there is nothing to cancel, so stop it immediately
                    // without disturbing other queued or active videos.
                    UpdateJob(jobId, "cancelled", "Stopped while queued, before any provider was used. Other queued videos continue.");
                    return;
                }
                // A worker is already running this video. Only the host loop can cancel that
                // specific worker's own cancellation token, so record the request for it to pick
                // up; other jobs and providers are entirely unaffected.
                if (stopJobRequestIds.Add(jobId)) stopJobRequests.Enqueue(jobId);
            }
        }

        public void PauseJob(string jobId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (Terminal(job)) throw new InvalidOperationException("This video already finished; there is nothing to pause.");
                // Marked before the worker (if any) is cancelled, so the same job reference lets
                // the worker attach a friendlier "paused" message instead of a generic one once
                // its own cancellation token actually stops it.
                job.PausedByUser = true;
                if (job.State == "queued")
                {
                    UpdateJob(jobId, "cancelled", "Paused while queued, before any provider was used. Resume anytime; other queued videos continue.");
                    return;
                }
                if (stopJobRequestIds.Add(jobId)) stopJobRequests.Enqueue(jobId);
            }
        }

        public void SetJobSummaryLevel(string jobId, string level)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (!ValidSummaryLevel(level)) throw new InvalidOperationException("Unknown summary level.");
                if (job.State != "queued" && !Terminal(job))
                    throw new InvalidOperationException("A video that is currently running cannot have its summary level changed.");
                if (job.SummaryLevel == level) return;
                string previousLevel = job.SummaryLevel, previousState = job.State, previousMessage = job.Message;
                bool previousPausedByUser = job.PausedByUser;
                string previousResultUrl = job.ResultUrl, previousProviderName = job.ProviderName;
                int previousRotationCursor = job.RotationCursor, previousStageIndex = job.StageIndex;
                string previousProgress = job.Progress, previousRetryReason = job.RetryReason;
                string previousTranscriptHash = job.TranscriptHash, previousFinalResult = job.FinalResult;
                int previousTranscriptLength = job.TranscriptLength, previousChunkCount = job.ChunkCount;
                int previousSuccessfulParts = job.SuccessfulParts;
                List<string> previousPartResultUrls = new List<string>(job.PartResultUrls ?? new List<string>());
                DateTime previousUpdatedAt = job.UpdatedAt;
                job.SummaryLevel = level;
                if (Terminal(job))
                {
                    // A saved checkpoint/result was generated with the previous level. Keep this
                    // job stopped and require an explicit retry rather than mixing old stages with
                    // the newly selected level or starting historical work automatically.
                    job.State = "cancelled";
                    job.Message = "Summary level changed. Previous progress was cleared; click Retry from checkpoint when you want to run it.";
                    job.PausedByUser = true;
                    job.ResultUrl = "";
                    job.PartResultUrls = new List<string>();
                    job.ProviderName = "ChatGPT";
                    job.RotationCursor = 0;
                    job.StageIndex = 0;
                    job.Progress = "";
                    job.RetryReason = "";
                    job.TranscriptHash = "";
                    job.TranscriptLength = 0;
                    job.ChunkCount = 0;
                    job.SuccessfulParts = 0;
                    job.TranscriptSaved = false;
                    job.FinalResult = "";
                }
                job.UpdatedAt = DateTime.UtcNow;
                try { Persist(job); }
                catch
                {
                    job.SummaryLevel = previousLevel;
                    job.State = previousState;
                    job.Message = previousMessage;
                    job.PausedByUser = previousPausedByUser;
                    job.ResultUrl = previousResultUrl;
                    job.PartResultUrls = previousPartResultUrls;
                    job.ProviderName = previousProviderName;
                    job.RotationCursor = previousRotationCursor;
                    job.StageIndex = previousStageIndex;
                    job.Progress = previousProgress;
                    job.RetryReason = previousRetryReason;
                    job.TranscriptHash = previousTranscriptHash;
                    job.TranscriptLength = previousTranscriptLength;
                    job.ChunkCount = previousChunkCount;
                    job.SuccessfulParts = previousSuccessfulParts;
                    job.FinalResult = previousFinalResult;
                    job.UpdatedAt = previousUpdatedAt;
                    throw;
                }
            }
        }

        public void SetJobWatchLater(string jobId, bool watchLater)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                if (job.WatchLater == watchLater) return;
                if (watchLater && !Terminal(job) && job.State != "queued")
                {
                    // A worker is already running this video. Reuse the exact same cancellation
                    // path as the "Stop this video" button; the worker's own loop sees the
                    // request, cancels its linked token, and records the terminal state itself.
                    // Other jobs and providers are entirely unaffected.
                    if (stopJobRequestIds.Add(jobId)) stopJobRequests.Enqueue(jobId);
                }
                job.WatchLater = watchLater;
                job.UpdatedAt = DateTime.UtcNow;
                Persist(job);
            }
        }

        public string TakeJobStopRequest()
        {
            lock (gate)
            {
                if (stopJobRequests.Count == 0) return null;
                string id = stopJobRequests.Dequeue();
                stopJobRequestIds.Remove(id);
                return id;
            }
        }

        public void ClearJobProgress(string jobId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                job.State = "queued";
                job.Message = "Local transcript and summary progress cleared.";
                job.PausedByUser = false;
                job.ResultUrl = "";
                job.PartResultUrls = new List<string>();
                job.ProviderName = "ChatGPT";
                job.RotationCursor = 0;
                job.StageIndex = 0;
                job.Progress = "";
                job.RetryReason = "";
                job.TranscriptHash = "";
                job.TranscriptLength = 0;
                job.ChunkCount = 0;
                job.SuccessfulParts = 0;
                job.TranscriptSaved = false;
                // A clean run deserves a full automatic attempts budget, exactly like a manual
                // retry; otherwise an exhausted history silently disables self-repair.
                job.AutoRetryAttempts = 0;
                job.AutoRetryAfterUtc = DateTime.MinValue;
                failureReportIds.Remove(jobId);
                string resultPath = stateDirectory == null ? null : Path.Combine(stateDirectory, job.Id + ".result.txt");
                string previousFinalResult = job.FinalResult;
                job.FinalResult = "";
                job.UpdatedAt = DateTime.UtcNow;
                Persist(job);
                try
                {
                    if (resultPath != null) DeleteFileWithRetry(resultPath, "full transcript result");
                    DeletePartCheckpoint(jobId);
                }
                catch
                {
                    job.FinalResult = previousFinalResult;
                    job.UpdatedAt = DateTime.UtcNow;
                    Persist(job);
                    throw;
                }
                ClearRestartHold();
            }
        }

        public int ClearErrorJobs()
        {
            lock (gate)
            {
                Job[] failed = jobs.Where(job => job.State == "error").ToArray();
                foreach (Job job in failed)
                {
                    RemoveJobFiles(job, "failed");
                    jobs.Remove(job);
                }
                return failed.Length;
            }
        }

        static int DuplicateRetentionRank(Job job)
        {
            if (job.State == "completed" && (!String.IsNullOrEmpty(job.ResultUrl) || job.FinalResult == "local")) return 5;
            if (job.State == "completed") return 4;
            if (job.State == "submitted") return 3;
            if (job.State == "error" || job.State == "needs-review") return 2;
            if (job.State == "reviewed") return 1;
            return 0;
        }

        public int ClearDuplicateJobs()
        {
            lock (gate)
            {
                Job[] duplicates = jobs.Where(Terminal)
                    .GroupBy(job => (job.VideoId ?? "") + "\n" + (job.SummaryLevel ?? "legacy") + "\n" +
                        (job.SummaryLanguage ?? "hebrew"), StringComparer.Ordinal)
                    .SelectMany(group => group.OrderByDescending(DuplicateRetentionRank)
                        .ThenByDescending(job => job.UpdatedAt).ThenByDescending(job => job.Sequence).Skip(1))
                    .ToArray();
                foreach (Job job in duplicates)
                {
                    RemoveJobFiles(job, "duplicate");
                    jobs.Remove(job);
                }
                return duplicates.Length;
            }
        }

        public int ClearCancelledJobs()
        {
            lock (gate)
            {
                Job[] retired = jobs.Where(job => job.State == "cancelled" || job.State == "reviewed").ToArray();
                foreach (Job job in retired)
                {
                    RemoveJobFiles(job, "retired");
                    jobs.Remove(job);
                }
                return retired.Length;
            }
        }

        public void DeleteJob(string jobId)
        {
            lock (gate)
            {
                Job job = jobs.Find(j => j.Id == jobId);
                if (job == null) throw new InvalidOperationException("Unknown job.");
                // A video that is still queued has not been picked up by any worker yet, and a
                // terminal video is no longer owned by one either. Anything else (starting,
                // loading, verification, sending, generating, summarizing, combining, paused,
                // etc.) is actively in flight, so deleting it here could race a worker still
                // writing to the same job file.
                if (job.State != "queued" && !Terminal(job))
                    throw new InvalidOperationException("This video is still being processed. Stop it first, then remove it.");
                RemoveJobFiles(job, "removed");
                jobs.Remove(job);
            }
        }

        void Handle(TcpClient client)
        {
            JavaScriptSerializer json = new JavaScriptSerializer();
            json.MaxJsonLength = Int32.MaxValue;
            NetworkStream stream = client.GetStream();
            try
            {
                IPAddress remoteAddress = ((IPEndPoint)client.Client.RemoteEndPoint).Address;
                if (!IPAddress.IsLoopback(remoteAddress) && !IsPrivateAddress(remoteAddress))
                    throw new HttpError(403, "Only loopback and private-network clients are allowed.");
                int remaining = 8192;
                string[] request = ReadLine(stream, ref remaining).Split(' ');
                if (request.Length != 3 || request[2] != "HTTP/1.1") throw new HttpError(400, "HTTP/1.1 is required.");
                string method = request[0], path = request[1];
                Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                string line;
                while ((line = ReadLine(stream, ref remaining)).Length > 0)
                {
                    int colon = line.IndexOf(':');
                    if (colon <= 0) throw new HttpError(400, "Invalid header.");
                    string key = line.Substring(0, colon);
                    if (!Regex.IsMatch(key, "^[A-Za-z0-9-]+$") || headers.ContainsKey(key))
                        throw new HttpError(400, "Invalid or repeated header.");
                    headers.Add(key, line.Substring(colon + 1).Trim());
                }
                string host = Header(headers, "Host");
                if (!AllowedHost(host))
                    throw new HttpError(421, "Unexpected host.");
                if (headers.ContainsKey("Transfer-Encoding") || headers.ContainsKey("Expect"))
                    throw new HttpError(400, "Unsupported request encoding.");
                int length = 0;
                if (headers.ContainsKey("Content-Length") &&
                    (!Int32.TryParse(Header(headers, "Content-Length"), out length) || length < 0))
                    throw new HttpError(400, "Invalid content length.");
                if (length > 2048) throw new HttpError(413, "Request body is too large.");
                if (method == "GET" && length != 0) throw new HttpError(400, "GET body is not supported.");
                byte[] bytes = new byte[length];
                int offset = 0;
                while (offset < length)
                {
                    int count = stream.Read(bytes, offset, length - offset);
                    if (count == 0) throw new IOException("Incomplete request body.");
                    offset += count;
                }
                if (method == "GET" && (path == "/" || path == "/app.js"))
                {
                    Write(stream, 200, path == "/" ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8",
                        path == "/" ? html : script);
                    return;
                }
                string origin = Header(headers, "Origin");
                string site = Header(headers, "Sec-Fetch-Site");
                if (!EqualToken(Header(headers, "X-YT-Token"), token) ||
                    (origin != null && origin != RequestOrigin(host)) ||
                    (site != null && site != "same-origin"))
                    throw new HttpError(403, "Unauthorized local request.");
                if (method == "GET" && path == "/api/status")
                {
                    lock (gate)
                    {
                        Write(stream, 200, "application/json; charset=utf-8", json.Serialize(new {
                            app = "YT Summary", ready = browserReady, stopping = stopRequested,
                            browserMessage = browserMessage,
                            summaryLevel = defaultSummaryLevel,
                            summaryLanguage = defaultSummaryLanguage,
                            enabledProviders = enabledProviders.ToArray(),
                            keepIntermediateTabs = keepIntermediateTabs,
                            paused = dispatchPaused, pauseReason = pauseReason, pauseKind = pauseKind,
                            autoRetryLimit = MaxAutoRetryAttempts,
                            pausedWorkers = jobs.Count(j => j.State == "paused"),
                            maxConcurrent = maxConcurrent, startIntervalMilliseconds = startIntervalMilliseconds,
                            mobileOrigin = MobileOrigin,
                            providerOrder = new [] { "ChatGPT", "Gemini", "Claude" },
                            active = jobs.Count(j => !Terminal(j) && j.State != "queued"),
                            queued = jobs.Count(j => j.State == "queued"),
                            reviewRequired = jobs.Any(j => j.State == "needs-review"),
                            job = jobs.LastOrDefault(), jobs = jobs
                        }));
                    }
                    return;
                }
                if (method != "POST" || (path != "/api/jobs" && path != "/api/stop" &&
                    path != "/api/acknowledge" && path != "/api/resume" && path != "/api/settings" &&
                    path != "/api/retry" && path != "/api/clear" && path != "/api/clear-errors" &&
                    path != "/api/clear-duplicates" && path != "/api/stop-job" && path != "/api/pause-job" &&
                    path != "/api/set-job-level" && path != "/api/attach-result" && path != "/api/result" &&
                    path != "/api/delete-job" && path != "/api/clear-cancelled" && path != "/api/watch-later" &&
                    path != "/api/start-job"))
                    throw new HttpError(404, "Unknown endpoint.");
                if (origin != RequestOrigin(host) || Header(headers, "Content-Type") != "application/json")
                    throw new HttpError(403, "Same-origin JSON requests are required.");
                if (path == "/api/resume")
                {
                    if (bytes.Length != 2 || bytes[0] != 123 || bytes[1] != 125)
                        throw new HttpError(400, "Resume requires exactly {}.");
                    try { ResumeDispatch(); }
                    catch (InvalidOperationException ex)
                    {
                        lastServerError = ex.Message;
                        throw new HttpError(503, "Could not save the resume decision. Previous dispatch state is unchanged; check local state storage.");
                    }
                    Write(stream, 200, "application/json; charset=utf-8", "{\"paused\":false,\"pauseReason\":\"\"}");
                    return;
                }
                Dictionary<string, object> data;
                string body;
                try
                {
                    body = new UTF8Encoding(false, true).GetString(bytes);
                    data = json.Deserialize<Dictionary<string, object>>(body);
                }
                catch (ArgumentException) { throw new HttpError(400, "Invalid JSON."); }
                catch (InvalidOperationException) { throw new HttpError(400, "Invalid JSON."); }
                if (data == null) throw new HttpError(400, "A JSON object is required.");
                if (path == "/api/settings")
                {
                    string level;
                    List<string> providers;
                    string language;
                    bool? keepTabs;
                    if (!TryGetSettings(data, body, out level, out providers, out language, out keepTabs, false))
                        throw new HttpError(400, "Provide a valid summaryLevel, summaryLanguage (auto/hebrew/english), keepIntermediateTabs (true/false), and/or at least one enabled provider: ChatGPT, Gemini, Claude.");
                    lock (gate)
                    {
                        string nextLevel = level ?? defaultSummaryLevel;
                        List<string> nextProviders = providers ?? new List<string>(enabledProviders);
                        string nextLanguage = "hebrew";
                        bool nextKeepTabs = keepTabs ?? keepIntermediateTabs;
                        try { PersistSettings(nextLevel, nextProviders, nextLanguage, nextKeepTabs); }
                        catch (InvalidOperationException ex)
                        {
                            lastServerError = ex.Message;
                            throw new HttpError(503, "Could not save settings. The previous default is unchanged and provider settings are unchanged; check local state storage.");
                        }
                        defaultSummaryLevel = nextLevel;
                        enabledProviders = nextProviders;
                        defaultSummaryLanguage = nextLanguage;
                        keepIntermediateTabs = nextKeepTabs;
                        Write(stream, 200, "application/json; charset=utf-8", json.Serialize(new {
                            summaryLevel = defaultSummaryLevel, enabledProviders = enabledProviders.ToArray(),
                            summaryLanguage = defaultSummaryLanguage, keepIntermediateTabs = keepIntermediateTabs
                        }));
                    }
                    return;
                }
                if (path == "/api/stop")
                {
                    if (data.Count != 0) throw new HttpError(400, "Unexpected fields.");
                    stopRequested = true;
                    Write(stream, 200, "application/json; charset=utf-8", "{\"stopping\":true}");
                    return;
                }
                if (path == "/api/clear-errors")
                {
                    if (data.Count != 0) throw new HttpError(400, "Clear errors requires exactly {}.");
                    int cleared;
                    try { cleared = ClearErrorJobs(); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    Write(stream, 200, "application/json; charset=utf-8", json.Serialize(new { cleared = cleared }));
                    return;
                }
                if (path == "/api/clear-duplicates")
                {
                    if (data.Count != 0) throw new HttpError(400, "Clear duplicates requires exactly {}.");
                    int cleared;
                    try { cleared = ClearDuplicateJobs(); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    Write(stream, 200, "application/json; charset=utf-8", json.Serialize(new { cleared = cleared }));
                    return;
                }
                if (path == "/api/clear-cancelled")
                {
                    if (data.Count != 0) throw new HttpError(400, "Clear cancelled requires exactly {}.");
                    int cleared;
                    try { cleared = ClearCancelledJobs(); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    Write(stream, 200, "application/json; charset=utf-8", json.Serialize(new { cleared = cleared }));
                    return;
                }
                if (path == "/api/start-job")
                {
                    object startId;
                    if (data.Count != 1 || !data.TryGetValue("jobId", out startId) || !(startId is string) || !ValidGuid((string)startId))
                        throw new HttpError(400, "A valid jobId is required.");
                    try { Write(stream, 200, "application/json; charset=utf-8", json.Serialize(StartJobNow((string)startId))); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    return;
                }
                if (path == "/api/retry" || path == "/api/clear")
                {
                    object retryId;
                    if (data.Count != 1 || !data.TryGetValue("jobId", out retryId) || !(retryId is string) || !ValidGuid((string)retryId))
                        throw new HttpError(400, "A valid jobId is required.");
                    try
                    {
                        if (path == "/api/retry") Write(stream, 200, "application/json; charset=utf-8", json.Serialize(RetryJob((string)retryId)));
                        else { ClearJobProgress((string)retryId); Write(stream, 200, "application/json; charset=utf-8", "{\"cleared\":true}"); }
                    }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    return;
                }
                if (path == "/api/stop-job")
                {
                    object stopId;
                    if (data.Count != 1 || !data.TryGetValue("jobId", out stopId) || !(stopId is string) || !ValidGuid((string)stopId))
                        throw new HttpError(400, "A valid jobId is required.");
                    try { StopJob((string)stopId); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    Write(stream, 200, "application/json; charset=utf-8", "{\"stopping\":true}");
                    return;
                }
                if (path == "/api/delete-job")
                {
                    object deleteId;
                    if (data.Count != 1 || !data.TryGetValue("jobId", out deleteId) || !(deleteId is string) || !ValidGuid((string)deleteId))
                        throw new HttpError(400, "A valid jobId is required.");
                    try { DeleteJob((string)deleteId); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    Write(stream, 200, "application/json; charset=utf-8", "{\"deleted\":true}");
                    return;
                }
                if (path == "/api/pause-job")
                {
                    object pauseId;
                    if (data.Count != 1 || !data.TryGetValue("jobId", out pauseId) || !(pauseId is string) || !ValidGuid((string)pauseId))
                        throw new HttpError(400, "A valid jobId is required.");
                    try { PauseJob((string)pauseId); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    Write(stream, 200, "application/json; charset=utf-8", "{\"pausing\":true}");
                    return;
                }
                if (path == "/api/watch-later")
                {
                    object watchLaterId, watchLaterValue;
                    if (data.Count != 2 || !data.TryGetValue("jobId", out watchLaterId) || !(watchLaterId is string) ||
                        !ValidGuid((string)watchLaterId) || !data.TryGetValue("watchLater", out watchLaterValue) ||
                        !(watchLaterValue is bool))
                        throw new HttpError(400, "A valid jobId and watchLater (true/false) are required.");
                    try { SetJobWatchLater((string)watchLaterId, (bool)watchLaterValue); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    Write(stream, 200, "application/json; charset=utf-8", "{\"updated\":true}");
                    return;
                }
                if (path == "/api/set-job-level")
                {
                    object levelJobId, levelObject;
                    if (data.Count != 2 || !data.TryGetValue("jobId", out levelJobId) || !(levelJobId is string) || !ValidGuid((string)levelJobId) ||
                        !data.TryGetValue("summaryLevel", out levelObject) || !(levelObject is string) || !ValidSummaryLevel((string)levelObject))
                        throw new HttpError(400, "A valid jobId and summaryLevel are required.");
                    try { SetJobSummaryLevel((string)levelJobId, (string)levelObject); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    Write(stream, 200, "application/json; charset=utf-8", "{\"updated\":true}");
                    return;
                }
                if (path == "/api/attach-result")
                {
                    object attachId, attachUrl;
                    if (data.Count != 2 || !data.TryGetValue("jobId", out attachId) || !(attachId is string) ||
                        !ValidGuid((string)attachId) || !data.TryGetValue("resultUrl", out attachUrl) ||
                        !(attachUrl is string) || !ValidResultUrl((string)attachUrl) ||
                        !ValidStringFields(body, data.Count))
                        throw new HttpError(400, "A valid jobId and supported provider conversation URL are required.");
                    try { Write(stream, 200, "application/json; charset=utf-8", json.Serialize(AttachJobResult((string)attachId, (string)attachUrl))); }
                    catch (ArgumentException ex) { throw new HttpError(400, ex.Message); }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    return;
                }
                if (path == "/api/result")
                {
                    object resultId;
                    if (data.Count != 1 || !data.TryGetValue("jobId", out resultId) ||
                        !(resultId is string) || !ValidGuid((string)resultId))
                        throw new HttpError(400, "A valid jobId is required.");
                    try
                    {
                        Write(stream, 200, "application/json; charset=utf-8",
                            json.Serialize(new { finalResult = GetFinalResult((string)resultId) }));
                    }
                    catch (InvalidOperationException ex) { throw new HttpError(409, ex.Message); }
                    catch (IOException ex) { throw new HttpError(503, "Could not read the saved local result: " + ex.Message); }
                    return;
                }
                if (path == "/api/acknowledge")
                {
                    lock (gate)
                    {
                        object idObject;
                        string id;
                        if (data.Count == 0)
                        {
                            Job[] reviews = jobs.Where(j => j.State == "needs-review").ToArray();
                            if (reviews.Length != 1) throw new HttpError(409, "Choose a specific video's review on the refreshed dashboard.");
                            id = reviews[0].Id;
                        }
                        else if (data.Count == 1 && data.TryGetValue("jobId", out idObject) && idObject is string && ValidGuid((string)idObject))
                            id = (string)idObject;
                        else throw new HttpError(400, "A valid jobId is required.");
                        Job review = jobs.Find(j => j.Id == id && j.State == "needs-review");
                        if (review == null) throw new HttpError(409, "This video has no pending send to review.");
                        if (acknowledgementIds.Add(id)) acknowledgements.Enqueue(id);
                    }
                    Write(stream, 200, "application/json; charset=utf-8", "{\"acknowledged\":true}");
                    return;
                }
                object videoObject, requestObject, summaryObject, titleObject, watchLaterObject;
                bool hasSummaryLevel = data.TryGetValue("summaryLevel", out summaryObject);
                bool hasTitle = data.TryGetValue("title", out titleObject);
                bool hasWatchLater = data.TryGetValue("watchLater", out watchLaterObject);
                int expectedFields = 2 + (hasSummaryLevel ? 1 : 0) + (hasTitle ? 1 : 0) + (hasWatchLater ? 1 : 0);
                if (data.Count != expectedFields || !data.TryGetValue("videoId", out videoObject) ||
                    !data.TryGetValue("requestId", out requestObject) ||
                    !(videoObject is string) || !(requestObject is string) ||
                    (hasSummaryLevel && (!(summaryObject is string) || !ValidSummaryLevel((string)summaryObject))) ||
                    (hasTitle && (!(titleObject is string) || ((string)titleObject).Trim().Length > 300)) ||
                    (hasWatchLater && !(watchLaterObject is bool)) ||
                    !ValidJobFields(body, data.Count))
                    throw new HttpError(400, "A video ID and request ID, with optional valid summaryLevel, title and watchLater, are required.");
                string videoId = (string)videoObject, requestId = (string)requestObject;
                string title = hasTitle ? ((string)titleObject).Trim() : "";
                Guid parsed;
                if (!Regex.IsMatch(videoId, "^[A-Za-z0-9_-]{11}$") || !Guid.TryParseExact(requestId, "D", out parsed))
                    throw new HttpError(400, "Invalid video or request ID.");
                lock (gate)
                {
                    string summaryLevel = hasSummaryLevel ? (string)summaryObject : defaultSummaryLevel;
                    foreach (Job previous in jobs)
                    {
                        if (previous.RequestId == requestId)
                        {
                            if (previous.VideoId != videoId) throw new HttpError(409, "Request ID already belongs to another video.");
                            if (hasSummaryLevel && previous.SummaryLevel != summaryLevel)
                                throw new HttpError(409, "Request ID already belongs to another summary level.");
                            if (String.IsNullOrEmpty(previous.Title) && title.Length > 0) SetJobTitle(previous.Id, title);
                            Write(stream, 200, "application/json; charset=utf-8", json.Serialize(previous));
                            return;
                        }
                    }
                    if (stopRequested) throw new HttpError(503, "The helper is stopping. Start it again before adding videos.");
                    Job existingVideo = jobs.LastOrDefault(j => j.VideoId == videoId &&
                        j.SummaryLevel == summaryLevel && j.SummaryLanguage == defaultSummaryLanguage);
                    if (existingVideo != null)
                    {
                        if (String.IsNullOrEmpty(existingVideo.Title) && title.Length > 0) SetJobTitle(existingVideo.Id, title);
                        if (existingVideo.State == "completed" &&
                            (!String.IsNullOrEmpty(existingVideo.ResultUrl) || existingVideo.FinalResult == "local"))
                        {
                            DateTime previousUpdatedAt = existingVideo.UpdatedAt;
                            long previousSequence = existingVideo.Sequence;
                            long previousGlobalSequence = sequence;
                            try
                            {
                                existingVideo.UpdatedAt = DateTime.UtcNow;
                                existingVideo.Sequence = ++sequence;
                                Persist(existingVideo);
                            }
                            catch
                            {
                                existingVideo.UpdatedAt = previousUpdatedAt;
                                existingVideo.Sequence = previousSequence;
                                sequence = previousGlobalSequence;
                                throw;
                            }
                            jobs.Remove(existingVideo);
                            jobs.Add(existingVideo);
                        }
                        Write(stream, 200, "application/json; charset=utf-8", json.Serialize(existingVideo));
                        return;
                    }
                    if (jobs.Count(j => !Terminal(j) || j.State == "needs-review") >= 200)
                        throw new HttpError(429, "The queue is full (200 unfinished videos). Wait or review pending sends.");
                    DateTime now = DateTime.UtcNow;
                    while (submissions.Count > 0 && (now - submissions.Peek()).TotalMinutes >= 1) submissions.Dequeue();
                    if (submissions.Count >= 120) throw new HttpError(429, "Too many requests. Wait one minute.");
                    submissions.Enqueue(now);
                    Job added = new Job { Id = Guid.NewGuid().ToString("D"), RequestId = requestId,
                        VideoId = videoId, Title = title, SummaryLevel = summaryLevel, SummaryLanguage = defaultSummaryLanguage,
                        WatchLater = hasWatchLater && (bool)watchLaterObject,
                        ProviderName = "ChatGPT", RotationCursor = 0,
                        StageIndex = 0, Progress = "", RetryReason = "", State = "queued", Message = "Queued for its own transcript and browser provider tab.",
                        PartResultUrls = new List<string>(),
                        CreatedAt = now, UpdatedAt = now, Sequence = ++sequence };
                    Persist(added);
                    jobs.Add(added);
                    // Adding a video is an explicit request to work, so the automatic
                    // restart hold clears itself. A real usage-limit pause still stands.
                    ClearRestartHold();
                    Job[] history = jobs.Where(j => Terminal(j) && j.State != "needs-review").ToArray();
                    foreach (Job old in history.Take(Math.Max(0, history.Length - 100)))
                    {
                        RemoveJobFiles(old, "expired");
                        jobs.Remove(old);
                    }
                    Write(stream, 202, "application/json; charset=utf-8", json.Serialize(added));
                }
            }
            catch (HttpError ex)
            {
                Write(stream, ex.Status, "application/json; charset=utf-8", json.Serialize(new { error = ex.Message }));
            }
        }

        static void Write(NetworkStream stream, int status, string type, string body)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(body);
            string headers = "HTTP/1.1 " + status + " Response\r\nContent-Type: " + type +
                "\r\nContent-Length: " + bytes.Length + "\r\nConnection: close\r\nCache-Control: no-store" +
                "\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer" +
                "\r\nCross-Origin-Opener-Policy: same-origin" +
                "\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'\r\n\r\n";
            byte[] head = Encoding.ASCII.GetBytes(headers);
            stream.Write(head, 0, head.Length);
            stream.Write(bytes, 0, bytes.Length);
        }

        public void Dispose()
        {
            running = false;
            listener.Stop();
            if (thread != null) thread.Join(5000);
        }
    }
}
