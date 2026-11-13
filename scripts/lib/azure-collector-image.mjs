// The default is an immutable Contrib image that includes the Azure Monitor exporter.
export const collectorRepository = 'otel/opentelemetry-collector-contrib';
export const collectorTag = `${collectorRepository}:0.119.0`;
export const collectorSource = `docker.io/${collectorRepository}@sha256:36c35cc213c0f3b64d6e8a3e844dc90822f00725e0e518eaed5b08bcc2231e72`;
