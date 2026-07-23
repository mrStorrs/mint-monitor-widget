UUID := service-monitor@mrStorrs
PAYLOAD := $(UUID)/files/$(UUID)
ARCHIVE := dist/$(UUID).zip

.PHONY: check package install-local clean

check:
	node --check $(PAYLOAD)/desklet.js
	node --check $(PAYLOAD)/serviceState.js
	node tests/service_state.test.js
	node tests/spice_structure.test.js

package:
	mkdir -p dist
	zip -qr -FS $(ARCHIVE) $(UUID)

install-local:
	./scripts/install-local.sh

clean:
	rm -f $(ARCHIVE)
