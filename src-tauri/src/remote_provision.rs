use serde::{Deserialize, Serialize};

use crate::git::credential::HttpCredential;

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum RepositoryProvision {
    Create,
    Clone {
        url: String,
        name: String,
        credential: Option<HttpCredential>,
    },
}
