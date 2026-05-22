// bitnet_engine.cpp
//
// Implementation of BitnetEngine. See bitnet_engine.h for the public contract
// and ADR-002 for the design rationale (pimpl, single-threaded, std::function
// callbacks, atomic cancellation).

#include "bitnet_engine.h"

#include "llama.h"

#include "common.h"
#include "sampling.h"

#include <algorithm>
#include <chrono>
#include <mutex>
#include <stdexcept>
#include <iostream>

namespace bitnet {

namespace {

// Read a GGUF metadata string by key. Returns empty string if absent.
std::string read_meta_str(const llama_model* model, const char* key) {
    char buf[256];
    int32_t n = llama_model_meta_val_str(model, key, buf, sizeof(buf));
    if (n < 0) return {};
    const size_t len = std::min<size_t>(static_cast<size_t>(n), sizeof(buf) - 1);
    return std::string(buf, len);
}

// llama_backend_init() is idempotent but cheap; std::call_once keeps it crisp
// in case create() runs concurrently from a future multi-engine setup.
void ensure_backend_initialized() {
    static std::once_flag once;
    std::call_once(once, []() { llama_backend_init(); });
}

// Returns the largest k <= want such that s[0..k) ends at a UTF-8 character
// boundary — i.e. contains only complete multi-byte sequences. Used to ensure
// the holdback buffer never emits a truncated multi-byte char to the streaming
// callback. llama.cpp tokenizers can split a single multi-byte codepoint
// across consecutive tokens, so token pieces (and any concatenation of them)
// can end mid-character. Passing such bytes to JNI's NewStringUTF aborts the
// process with "illegal continuation byte" since Modified UTF-8 requires
// terminating sequences to be complete.
size_t utf8_safe_prefix_len(const std::string& s, size_t want) {
    if (want > s.size()) want = s.size();
    if (want == 0) return 0;

    // Walk backward from `want` skipping over any continuation bytes — these
    // belong to a character whose start byte is earlier in the string.
    size_t k = want;
    while (k > 0) {
        const unsigned char b = static_cast<unsigned char>(s[k - 1]);
        if ((b & 0xC0) == 0x80) {  // continuation byte: 10xxxxxx
            --k;
            continue;
        }
        // b is a start byte. Determine the expected total length of the
        // character it begins.
        size_t expected;
        if      ((b & 0x80) == 0x00) expected = 1;  // 0xxxxxxx
        else if ((b & 0xE0) == 0xC0) expected = 2;  // 110xxxxx
        else if ((b & 0xF0) == 0xE0) expected = 3;  // 1110xxxx
        else if ((b & 0xF8) == 0xF0) expected = 4;  // 11110xxx
        else { return k - 1; }                       // invalid start byte
        const size_t have = want - (k - 1);
        return have >= expected ? want : (k - 1);
    }
    // s[0..want) is entirely continuation bytes — emit nothing.
    return 0;
}

}  // namespace

// ============================================================================
// Impl
// ============================================================================

struct BitnetEngine::Impl {
    llama_model*    model = nullptr;
    llama_context*  ctx   = nullptr;
    ModelInfo       info;
    std::atomic<bool> cancel_flag{false};

    // Kept around so generate() can read n_batch without re-parsing config.
    common_params base_params;

    ~Impl() {
        if (ctx)   { llama_free(ctx);         ctx   = nullptr; }
        if (model) { llama_free_model(model); model = nullptr; }
    }
};

// ============================================================================
// create()
// ============================================================================

std::unique_ptr<BitnetEngine> BitnetEngine::create(const EngineConfig& config) {
    ensure_backend_initialized();

    common_params params;
    params.model               = config.model_path;
    params.n_ctx               = config.n_ctx;
    params.n_batch             = config.n_batch;
    params.cpuparams.n_threads = config.n_threads;
    params.n_gpu_layers        = 0;     // ← ADD THIS LINE

    common_init_result init = common_init_from_params(params);
    if (init.model == nullptr || init.context == nullptr) {
        if (init.context) llama_free(init.context);
        if (init.model)   llama_free_model(init.model);
        throw std::runtime_error("Failed to load model from " + config.model_path);
    }

    auto engine = std::unique_ptr<BitnetEngine>(new BitnetEngine());
    engine->impl_->model       = init.model;
    engine->impl_->ctx         = init.context;
    engine->impl_->base_params = std::move(params);

    engine->impl_->info.architecture     = read_meta_str(init.model, "general.architecture");
    engine->impl_->info.n_vocab          = llama_n_vocab(init.model);
    engine->impl_->info.n_ctx_train      = llama_n_ctx_train(init.model);
    engine->impl_->info.n_embd           = llama_n_embd(init.model);
    engine->impl_->info.model_size_bytes = static_cast<int64_t>(llama_model_size(init.model));

    return engine;
}

// ============================================================================
// Constructor / destructor
// ============================================================================

BitnetEngine::BitnetEngine() : impl_(std::make_unique<Impl>()) {}
BitnetEngine::~BitnetEngine() = default;

// ============================================================================
// generate()
// ============================================================================

GenerationResult BitnetEngine::generate(
    const std::string& prompt,
    const GenerationParams& params,
    const TokenCallback& on_token)
{
    impl_->cancel_flag.store(false, std::memory_order_relaxed);
    const auto t_start = std::chrono::steady_clock::now();

    GenerationResult result;
    result.finish_reason = FinishReason::Length;

    common_sampler_params sparams;
    sparams.seed            = params.seed ? params.seed : LLAMA_DEFAULT_SEED;
    sparams.temp            = params.temperature;
    sparams.top_k           = params.top_k;
    sparams.top_p           = params.top_p;
    sparams.penalty_repeat  = params.repeat_penalty;
    sparams.penalty_last_n  = params.repeat_last_n;
    sparams.penalty_freq    = params.frequency_penalty;
    sparams.penalty_present = params.presence_penalty;

    common_sampler* smpl = common_sampler_init(impl_->model, sparams);
    if (!smpl) {
        result.finish_reason = FinishReason::Error;
        return result;
    }

    struct SamplerGuard {
        common_sampler* s;
        ~SamplerGuard() { if (s) common_sampler_free(s); }
    } guard{smpl};

    // Tokenize prompt (add_bos drives off model metadata).
    std::vector<llama_token> prompt_tokens =
        common_tokenize(impl_->ctx, prompt, /*add_special*/ false, /*parse_special*/ true);

    if (prompt_tokens.empty()) {
        throw std::runtime_error("prompt tokenized to zero tokens");
    }

    result.prompt_tokens = static_cast<int>(prompt_tokens.size());

    // Prompt prefill in chunks of n_batch.
    const int n_batch = impl_->base_params.n_batch;
    int n_past = 0;
    for (size_t i = 0; i < prompt_tokens.size(); i += static_cast<size_t>(n_batch)) {
        const int n_eval = static_cast<int>(
            std::min<size_t>(static_cast<size_t>(n_batch), prompt_tokens.size() - i));

        llama_batch batch = llama_batch_get_one(
            prompt_tokens.data() + i, n_eval, n_past, /*seq_id*/ 0);

        if (llama_decode(impl_->ctx, batch) != 0) {
            throw std::runtime_error("llama_decode failed on prompt");
        }

        for (int k = 0; k < n_eval; k++) {
            common_sampler_accept(smpl, prompt_tokens[i + k], /*accept_grammar=*/false);
        }

        n_past += n_eval;
    }

    // Token-by-token generation loop.
    //
    // Stop sequences are honored OpenAI-style: when a stop string appears in
    // the output, the matched substring (and anything after it within the
    // current piece) is trimmed from the returned text and is NOT emitted to
    // the streaming callback. To make this work across token boundaries — a
    // stop string can straddle the seam between two pieces — we keep a small
    // "holdback" suffix that is not yet committed to either the callback or
    // accumulated_text. The held tail length covers two concerns:
    //
    //   (a) The longest possible incomplete stop-sequence prefix, so a stop
    //       split across two pieces still triggers a match. That's
    //       (max stop length - 1) bytes.
    //
    //   (b) The longest possible incomplete trailing UTF-8 character — up to
    //       3 bytes for a 4-byte codepoint. Without this, the flush boundary
    //       could split a multi-byte codepoint, and the JNI NewStringUTF call
    //       on the resulting partial bytes would abort the process. This is
    //       a real risk even with no stop sequences set, because llama.cpp's
    //       tokenizers can split a single codepoint across consecutive tokens.
    //
    // We take the max of the two so a single uniform loop body handles both.
    size_t max_stop_len = 0;
    for (const auto& stop : params.stop_sequences) {
        if (stop.size() > max_stop_len) max_stop_len = stop.size();
    }
    const size_t stop_holdback = max_stop_len > 0 ? max_stop_len - 1 : 0;
    constexpr size_t utf8_max_partial = 3;
    const size_t holdback = std::max(stop_holdback, utf8_max_partial);

    std::string accumulated_text;
    std::string held;  // suffix not yet emitted to callback / accumulated_text
    int tokens_generated = 0;

    // Emit a substring to the streaming callback and the accumulated text in
    // one place so the cleanup paths stay consistent. Returns Stop if the
    // caller asked us to cancel.
    auto emit = [&](const std::string& s) -> CallbackResult {
        if (s.empty()) return CallbackResult::Continue;
        accumulated_text += s;
        return on_token(s);
    };

    while (tokens_generated < params.max_tokens) {
        if (impl_->cancel_flag.load(std::memory_order_relaxed)) {
            result.finish_reason = FinishReason::Cancelled;
            break;
        }

        const llama_token id = common_sampler_sample(smpl, impl_->ctx, /*idx*/ -1);
        common_sampler_accept(smpl, id, /*accept_grammar*/ true);

        if (llama_token_is_eog(impl_->model, id)) {
            result.finish_reason = FinishReason::EndOfSequence;
            break;
        }

        std::string piece = common_token_to_piece(impl_->ctx, id, /*special*/ false);

        // Combine the previously held tail with the new piece, then look for
        // any stop sequence in the combined buffer. The earliest match (lowest
        // position) wins, so multi-stop callers get deterministic truncation.
        std::string combined = held + piece;
        size_t stop_pos = std::string::npos;
        for (const auto& stop : params.stop_sequences) {
            if (stop.empty()) continue;
            size_t p = combined.find(stop);
            if (p != std::string::npos && p < stop_pos) stop_pos = p;
        }

        if (stop_pos != std::string::npos) {
            // Emit only what comes before the matched stop, then quit. The
            // matched stop sequence and any trailing content from this piece
            // are trimmed (OpenAI behavior).
            //
            // The pre-stop prefix is by construction part of the model's
            // already-emitted text, so it ends at a UTF-8 char boundary if all
            // prior flushes did — which they do, by induction.
            emit(combined.substr(0, stop_pos));
            held.clear();
            result.finish_reason = FinishReason::StopSequence;
            break;
        }

        // No stop yet. Flush everything except the last `holdback` bytes,
        // backed off to the nearest UTF-8 character boundary so we never emit
        // a truncated multi-byte codepoint.
        if (combined.size() > holdback) {
            const size_t target = combined.size() - holdback;
            const size_t flush_len = utf8_safe_prefix_len(combined, target);
            if (flush_len > 0) {
                if (emit(combined.substr(0, flush_len)) == CallbackResult::Stop) {
                    // User cancelled mid-flush. No need to update `held` —
                    // it isn't observed past the break (the cleanup path
                    // intentionally skips flushing on Cancelled).
                    result.finish_reason = FinishReason::Cancelled;
                    break;
                }
                held = combined.substr(flush_len);
            } else {
                // utf8_safe_prefix_len could only return 0 if the entire
                // target prefix is continuation bytes — rare, but defensible.
                held = std::move(combined);
            }
        } else {
            held = std::move(combined);
        }

        // Feed the sampled token back so the next sample sees fresh logits.
        llama_token id_buf = id;
        llama_batch next = llama_batch_get_one(&id_buf, 1, n_past, /*seq_id*/ 0);
        if (llama_decode(impl_->ctx, next) != 0) {
            throw std::runtime_error("llama_decode failed on generation step");
        }
        n_past++;
        tokens_generated++;
    }

    // Flush any remaining held suffix on the natural-completion paths (EOS,
    // length). For Cancelled we skip — the caller explicitly asked us to stop
    // emitting, so don't squeeze out one last chunk. For StopSequence `held`
    // was cleared above. In either skipped case the held bytes do NOT appear
    // in accumulated_text, matching the contract that emit() is the single
    // source of truth for the returned text.
    if ((result.finish_reason == FinishReason::EndOfSequence ||
         result.finish_reason == FinishReason::Length) && !held.empty()) {
        // Drop any trailing incomplete UTF-8 sequence. If the model stopped
        // mid-codepoint, those bytes can never complete — emitting them would
        // crash NewStringUTF and they wouldn't render anyway.
        const size_t safe_end = utf8_safe_prefix_len(held, held.size());
        if (safe_end > 0) emit(held.substr(0, safe_end));
        held.clear();
    }

    result.text             = std::move(accumulated_text);
    result.tokens_generated = tokens_generated;

    const auto t_end = std::chrono::steady_clock::now();
    result.wall_time_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        t_end - t_start).count();

    return result;
}

// ============================================================================
// cancel() / model_info()
// ============================================================================

void BitnetEngine::cancel() {
    impl_->cancel_flag.store(true, std::memory_order_relaxed);
}

ModelInfo BitnetEngine::model_info() const {
    return impl_->info;
}

std::string BitnetEngine::apply_chat_template(
    const std::vector<ChatMessage>& messages,
    bool add_assistant_header) const
{
    // Require the model to ship a chat template in its GGUF metadata. llama.cpp
    // will silently fall back to a bizarre default ("System: …User: …<|eot_id|>
    // Assistant:") for models without one, which is OOD for every real model
    // and produces gibberish output. Surfacing a clear error instead lets the
    // caller decide: format the prompt manually and use engine.generate() with
    // the raw string, or load a different model.
    {
        // Probe for the chat template metadata up front. We don't read the
        // value here — `llama_chat_apply_template(model, nullptr, ...)` will
        // fetch and apply it below. The probe exists purely to give callers
        // a clear, typed error when the key is absent rather than letting
        // llama.cpp fall back to its built-in "System:/User:/Assistant:"
        // approximation, which is OOD for every real model.
        char probe[1];
        const int32_t n = llama_model_meta_val_str(
            impl_->model, "tokenizer.chat_template", probe, sizeof(probe));
        if (n <= 0) {
            throw std::runtime_error(
                "Model has no `tokenizer.chat_template` GGUF metadata. "
                "Render the prompt manually and pass it to engine.generate() "
                "instead of using applyChatTemplate.");
        }
    }

    // Build llama.cpp's view of the chat. Pointers reference the caller's
    // ChatMessage strings — safe because we don't mutate `messages` here and
    // llama_chat_apply_template only reads them synchronously.
    std::vector<llama_chat_message> msgs;
    msgs.reserve(messages.size());
    for (const auto& m : messages) {
        msgs.push_back({m.role.c_str(), m.content.c_str()});
    }

    // Initial buffer sizing follows the upstream recommendation (2x total
    // chars) with a floor for very short chats. If it's too small we resize
    // and retry exactly once — llama_chat_apply_template returns the bytes
    // it would have written, so the second pass is guaranteed to fit.
    size_t total_chars = 0;
    for (const auto& m : messages) {
        total_chars += m.role.size() + m.content.size();
    }
    std::vector<char> buf(std::max<size_t>(total_chars * 2, 4096));

    // tmpl=nullptr → use the model's GGUF metadata template (which we just
    // verified exists). llama.cpp pattern-matches the Jinja string against
    // its built-in list of recognized templates (chatml, llama2, llama3,
    // mistral, gemma, qwen, etc.) and renders accordingly.
    int32_t needed = llama_chat_apply_template(
        impl_->model, /*tmpl=*/nullptr,
        msgs.data(), msgs.size(),
        add_assistant_header,
        buf.data(), static_cast<int32_t>(buf.size()));

    if (needed < 0) {
        throw std::runtime_error(
            "llama_chat_apply_template failed — model's chat template is "
            "present in metadata but does not match any format llama.cpp "
            "recognizes. Render the prompt manually instead.");
    }

    if (static_cast<size_t>(needed) > buf.size()) {
        buf.resize(static_cast<size_t>(needed));
        needed = llama_chat_apply_template(
            impl_->model, nullptr,
            msgs.data(), msgs.size(),
            add_assistant_header,
            buf.data(), static_cast<int32_t>(buf.size()));
        if (needed < 0) {
            throw std::runtime_error(
                "llama_chat_apply_template failed on retry after buffer resize");
        }
    }

    return std::string(buf.data(), static_cast<size_t>(needed));
}

}  // namespace bitnet
