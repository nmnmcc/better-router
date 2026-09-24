# Better Router

Better Router maps model requests to configured model deployments and can expose provider-compatible network endpoints from the same configuration.

## Language

**Plugin**:
A named collection of related capabilities that can contribute model execution, routing behavior, or externally accessible endpoints.
_Avoid_: Gateway plugin for the application as a whole

**Model route**:
A public model name and its eligible deployments in fallback order.
_Avoid_: HTTP route, endpoint

**Deployment**:
A configured target for a provider-native model, including the upstream communication modes it supports.
_Avoid_: Plugin, public model name

**HTTP endpoint**:
An externally accessible method and path with a request and response wire format.
_Avoid_: Model route

**Ingress**:
The way a caller enters Better Router, such as an in-process SDK call or an HTTP or WebSocket connection.
_Avoid_: Upstream transport

**Upstream transport**:
The communication mode Better Router uses to invoke a deployment after routing.
_Avoid_: Ingress
