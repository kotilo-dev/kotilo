namespace Hub.Core.Dictation;

/// <summary>Microphone audio to what Whisper expects: 16 kHz mono float in [-1, 1] (spec §22.2).</summary>
public static class AudioSamples
{
    public const int WhisperRate = 16_000;

    /// <summary>Below this RMS a 30 ms window counts as silence (about -46 dBFS).</summary>
    public const float SilenceRms = 0.005f;

    /// <summary>Averages interleaved channels into one.</summary>
    public static float[] ToMono(ReadOnlySpan<float> interleaved, int channels)
    {
        if (channels <= 1)
        {
            return interleaved.ToArray();
        }

        var frames = interleaved.Length / channels;
        var mono = new float[frames];
        for (var f = 0; f < frames; f++)
        {
            var sum = 0f;
            for (var c = 0; c < channels; c++)
            {
                sum += interleaved[(f * channels) + c];
            }

            mono[f] = sum / channels;
        }

        return mono;
    }

    /// <summary>
    /// Resamples mono audio. Downsampling averages the source samples each output sample covers (a box filter, enough
    /// against aliasing for speech); upsampling interpolates linearly.
    /// </summary>
    public static float[] Resample(ReadOnlySpan<float> mono, int fromRate, int toRate = WhisperRate)
    {
        if (fromRate == toRate || mono.Length == 0)
        {
            return mono.ToArray();
        }

        var ratio = (double)fromRate / toRate;
        var length = (int)(mono.Length / ratio);
        var output = new float[length];
        for (var i = 0; i < length; i++)
        {
            var start = i * ratio;
            if (ratio > 1)
            {
                var from = (int)start;
                var to = Math.Min(mono.Length, (int)Math.Ceiling(start + ratio));
                var sum = 0f;
                for (var j = from; j < to; j++)
                {
                    sum += mono[j];
                }

                output[i] = sum / Math.Max(1, to - from);
            }
            else
            {
                var index = (int)start;
                var next = Math.Min(index + 1, mono.Length - 1);
                var t = (float)(start - index);
                output[i] = (mono[index] * (1 - t)) + (mono[next] * t);
            }
        }

        return output;
    }

    public static float Rms(ReadOnlySpan<float> samples)
    {
        if (samples.IsEmpty)
        {
            return 0;
        }

        double sum = 0;
        foreach (var s in samples)
        {
            sum += s * s;
        }

        return (float)Math.Sqrt(sum / samples.Length);
    }

    /// <summary>
    /// Cuts leading and trailing silence, keeping <paramref name="padding"/> around speech so word edges survive.
    /// Returns an empty array when nothing is above <see cref="SilenceRms"/>.
    /// </summary>
    public static float[] TrimSilence(float[] samples, int rate = WhisperRate, double padding = 0.25)
    {
        var window = rate * 30 / 1000;
        int? first = null;
        var last = 0;
        for (var start = 0; start < samples.Length; start += window)
        {
            var length = Math.Min(window, samples.Length - start);
            if (Rms(samples.AsSpan(start, length)) >= SilenceRms)
            {
                first ??= start;
                last = start + length;
            }
        }

        if (first is null)
        {
            return [];
        }

        var pad = (int)(rate * padding);
        var from = Math.Max(0, first.Value - pad);
        var to = Math.Min(samples.Length, last + pad);
        return samples[from..to];
    }

    /// <summary>
    /// Whisper invents text for clips under a second; pad short speech with silence up to <paramref name="minimum"/>.
    /// </summary>
    public static float[] PadTo(float[] samples, TimeSpan minimum, int rate = WhisperRate)
    {
        var needed = (int)(minimum.TotalSeconds * rate);
        if (samples.Length >= needed)
        {
            return samples;
        }

        var padded = new float[needed];
        samples.CopyTo(padded, 0);
        return padded;
    }
}
