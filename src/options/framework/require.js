const moduleMap = {};

export async function require(path, type = 'js') {
    switch (type) {
        case 'js':
            return requirejs(path);
        case 'css':
            return requirecss(path)
        case 'html':
            return requirehtml(path)
        default:
            return undefined;
    }
}

export function define(module) {
    moduleMap.latest = module;
}

async function requirejs(path) {
    if (moduleMap[path]) return moduleMap[path];
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.id = `${path}-script`;
        script.src = `${path}.js`;
        script.type = 'module';
        script.className = 'page-script';
        script.setAttribute('async', '');
        script.setAttribute('defer', '');
        // A module that throws at top level still fires 'load' (the HTML spec only reports the error),
        // so reading `latest` unchecked handed this page the PREVIOUS page's module and cached it for
        // good; a fetch failure fires only 'error', and with no handler the load hung. A module's
        // define() and its 'load' run in the same task, so clearing `latest` here cannot eat another
        // page's define (audit 3.1.335 OPTUTIL-2).
        moduleMap.latest = undefined;
        script.onload = () => {
            const module = moduleMap.latest;
            moduleMap.latest = undefined;
            if (module === undefined) {
                script.remove();
                reject(new Error(`${path}.js ran but did not define a page module (it threw before define?)`));
                return;
            }
            moduleMap[path] = module;
            resolve(module);
        }
        script.onerror = () => {
            script.remove();
            reject(new Error(`${path}.js failed to load (the file or one of its imports is missing)`));
        };
        document.body.appendChild(script);
    });
}

async function requirecss(path) {
    const stylesheet = document.createElement('link');
    stylesheet.id = `${path}-stylesheet`;
    stylesheet.rel = 'stylesheet';
    stylesheet.href = `${path}.css`;
    stylesheet.className = 'page-stylesheet';
    return stylesheet;
}

async function requirehtml(path) {
    const body = document.createElement('div');
    body.id = `${path}-body`;
    body.innerHTML = await fetch(`${path}.html`).then(response => response.text());
    body.className = 'page-body';
    return body;
}