FROM --platform=linux/amd64 python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d AS model
COPY download_model.py model-manifest.json /build/
RUN python3 -I -B /build/download_model.py /build/model-manifest.json /model
FROM --platform=linux/amd64 node@sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27 AS node
FROM --platform=linux/amd64 ghcr.io/taeold/djev-run@sha256:efbf11a54e10c42b7d1379194befe100535171bfe9ed70dc1e431302d2b7a14b
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN node --version && node -e "require('node:http'); if(process.version!=='v22.23.1')process.exit(1)"
COPY --from=model /model/model-00001-of-00002.safetensors /opt/model/model-00001-of-00002.safetensors
COPY --from=model /model/model-00002-of-00002.safetensors /opt/model/model-00002-of-00002.safetensors
COPY --from=model /model/.gitattributes /model/.quant_summary.txt /model/README.md /model/apache_2.0_license.md /model/chat_template.jinja /model/config.json /model/generation_config.json /model/hf_quant_config.json /model/model.safetensors.index.json /model/processor_config.json /model/tokenizer.json /model/tokenizer_config.json /model/.ready /opt/model/
COPY patch_entrypoint.py images.json /opt/compass/
RUN python3 -I -B /opt/compass/patch_entrypoint.py /entrypoint.sh /opt/compass/images.json /opt/compass/model-entrypoint.sh
COPY launcher.mjs package.json /opt/compass/
COPY src/ /opt/compass/src/
COPY catalog/ /opt/compass/catalog/
COPY config/ /opt/compass/config/
ENV MODEL=/opt/model MAX_MODEL_LEN=4096 KV_CACHE_GB=2 ATTN=TRITON_ATTN TEST_PAGE=0 ENFORCE_EAGER=1 DISABLE_MM=1 TORCH_COMPILE_DISABLE=1 VLLM_WORKER_MULTIPROC_METHOD=fork VLLM_UF_EAGER_ALL=1 CUDA_MODULE_LOADING=LAZY CANVAS=128 MAX_SEQS=8 GPU_UTIL=0.92 COPY_TO_SHM=0 VLLM_ENABLE_V1_MULTIPROCESSING=0
ENTRYPOINT ["/usr/local/bin/node", "/opt/compass/launcher.mjs"]
