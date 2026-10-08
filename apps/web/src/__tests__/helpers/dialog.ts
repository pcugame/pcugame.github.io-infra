// jsdom does not implement the native dialog lifecycle or top layer.
Object.defineProperties(HTMLDialogElement.prototype, {
 showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute('open', ''); } },
 close: { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute('open'); } },
});
