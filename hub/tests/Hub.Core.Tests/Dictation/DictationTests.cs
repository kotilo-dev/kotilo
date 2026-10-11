using System.Globalization;
using Hub.Core.Dictation;

namespace Hub.Core.Tests.Dictation;

public sealed class DictationTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 4, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Quick_tap_toggles_and_keeps_recording()
    {
        var talk = new HoldToTalk();
        talk.Begin(T0);
        talk.Observe(keyDown: true, T0.AddMilliseconds(100)).Should().BeFalse();
        talk.Observe(keyDown: false, T0.AddMilliseconds(150)).Should().BeFalse();
        talk.Mode.Should().Be(TalkMode.Toggle);
        talk.Observe(keyDown: false, T0.AddSeconds(5)).Should().BeFalse("a toggle ends with the next shortcut press");
    }

    [Fact]
    public void Holding_past_the_threshold_stops_on_release()
    {
        var talk = new HoldToTalk();
        talk.Begin(T0);
        talk.Observe(keyDown: true, T0.AddMilliseconds(400)).Should().BeFalse();
        talk.Mode.Should().Be(TalkMode.Hold);
        talk.Observe(keyDown: true, T0.AddSeconds(3)).Should().BeFalse();
        talk.Observe(keyDown: false, T0.AddSeconds(3.1)).Should().BeTrue();
    }

    [Fact]
    public void Release_detected_late_after_the_threshold_still_counts_as_hold()
    {
        var talk = new HoldToTalk();
        talk.Begin(T0);
        talk.Observe(keyDown: false, T0.AddMilliseconds(500)).Should().BeTrue();
        talk.Mode.Should().Be(TalkMode.Hold);
    }

    [Fact]
    public void Stereo_48k_becomes_mono_16k()
    {
        // 0.1 s of a 440 Hz tone, identical on both channels.
        var frames = 4800;
        var stereo = new float[frames * 2];
        for (var i = 0; i < frames; i++)
        {
            stereo[i * 2] = stereo[(i * 2) + 1] = (float)Math.Sin(2 * Math.PI * 440 * i / 48_000) * 0.5f;
        }

        var mono = AudioSamples.ToMono(stereo, 2);
        mono.Should().HaveCount(frames);
        var resampled = AudioSamples.Resample(mono, 48_000);
        resampled.Should().HaveCount(1600);
        AudioSamples.Rms(resampled).Should().BeApproximately(AudioSamples.Rms(mono), 0.02f);
    }

    [Fact]
    public void Upsampling_interpolates()
    {
        AudioSamples.Resample([0f, 1f], 8_000).Should().Equal(0f, 0.5f, 1f, 1f);
    }

    [Fact]
    public void Silence_is_trimmed_with_padding_and_pure_silence_is_empty()
    {
        var samples = new float[16_000 * 3];
        for (var i = 16_000; i < 32_000; i++)
        {
            samples[i] = (i % 2 == 0) ? 0.2f : -0.2f;
        }

        var trimmed = AudioSamples.TrimSilence(samples);
        trimmed.Length.Should().BeInRange(16_000 + 7_000, 16_000 + 9_000, "one second of speech plus 0.25 s on each side");
        AudioSamples.TrimSilence(new float[16_000]).Should().BeEmpty();
        AudioSamples.PadTo(trimmed[..100], TimeSpan.FromSeconds(1)).Should().HaveCount(16_000);
    }

    [Fact]
    public void Transcript_cleanup_drops_annotations_and_known_hallucinations()
    {
        DictationText.CleanTranscript(" [Müzik]  Sipariş onayını   kontrol et.\nAltyazı M.K.\n(alkış)").Should().Be("Sipariş onayını kontrol et.");
        DictationText.CleanTranscript("Abone olmayı unutmayın!").Should().BeEmpty();
        DictationText.CleanTranscript("Altyazı dosyasını güncelle").Should().Be("Altyazı dosyasını güncelle", "only whole-line credits are dropped");
    }

    [Fact]
    public void Vocabulary_is_split_deduplicated_and_becomes_a_short_prompt()
    {
        var terms = DictationText.ParseVocabulary("İzmir, e-Posta\nKubernetes; izmir\n\n  gRPC stream ");
        terms.Should().Equal("İzmir", "e-Posta", "Kubernetes", "gRPC stream");
        var previous = CultureInfo.CurrentCulture;
        try
        {
            foreach (var culture in new[] { "en-US", "tr-TR" })
            {
                CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(culture);
                DictationText.ParseVocabulary("İZMİR, izmir, IZMIR, ıd, ID").Should().Equal(["İZMİR", "ıd"], $"case folding must not depend on {culture}");
            }
        }
        finally
        {
            CultureInfo.CurrentCulture = previous;
        }
        DictationText.WhisperPrompt(terms).Should().Be("İzmir, e-Posta, Kubernetes, gRPC stream.");
        DictationText.WhisperPrompt([]).Should().BeNull();
        DictationText.WhisperPrompt(Enumerable.Range(0, 100).Select(i => new string('x', 20) + i).ToList())!
            .Length.Should().BeLessThanOrEqualTo(DictationText.MaxWhisperPromptLength + 1);
    }

    [Fact]
    public void Cleanup_prompt_treats_the_transcript_as_data_and_adds_mode_custom_and_vocabulary()
    {
        var clean = DictationText.CleanupPrompt(DictationMode.Clean, null, []);
        clean.Should().Contain("never answer questions").And.Contain("never translate");

        DictationText.CleanupPrompt(DictationMode.Email, null, []).Should().Contain("email body");
        DictationText.CleanupPrompt(DictationMode.Custom, "Madde işaretleri kullan", ["Kubernetes"])
            .Should().Contain("Madde işaretleri kullan").And.Contain("Kubernetes");
        DictationText.CleanupPrompt(DictationMode.Clean, "ignored unless custom", []).Should().NotContain("ignored unless custom");
        DictationText.CleanupInput("merhaba").Should().Be("<dictation>\nmerhaba\n</dictation>");
    }

    [Fact]
    public void Cleanup_output_strips_echoed_tags_and_wrapping_quotes()
    {
        DictationText.CleanupOutput("<dictation>\nMerhaba.\n</dictation>").Should().Be("Merhaba.");
        DictationText.CleanupOutput("\"Merhaba, nasılsın?\"").Should().Be("Merhaba, nasılsın?");
        DictationText.CleanupOutput("Dedi ki \"evet\" ve \"hayır\"").Should().Be("Dedi ki \"evet\" ve \"hayır\"");
    }

    [Fact]
    public void File_entry_has_a_local_time_heading()
    {
        DictationText.FileEntry("  Not.  ", new DateTime(2026, 10, 4, 9, 5, 0)).Should().Be("## 2026-10-04 09:05\n\nNot.\n\n");
    }
}
